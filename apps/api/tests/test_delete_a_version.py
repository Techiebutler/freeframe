"""Deleting and restoring one version of an asset (#419).

`DELETE /assets/{asset_id}/versions/{version_id}` soft-deletes a version and
`POST .../restore` brings it back until the retention purge, which then reclaims
it as it does any soft-deleted version. Guarded here, each against a real
Postgres through the real app:
  * the delete is an editor's, answers with the asset's latest version
    afterwards, and refuses (409) an upload still in flight and the asset's
    last version that is ready or processing;
  * the restore brings back a version that landed, and nothing else: not one
    that was never deleted, not a discarded upload, not a purged one;
  * a deleted version leaves every read path: the version list, the asset's
    latest, share links (latest, and a version asked for by id), comments,
    the comment export, approvals and the storage count; a restore brings it
    all back;
  * two deletes racing on an asset's last two versions cannot both succeed.
"""
import threading
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.orm import Session as _SASession

from apps.api.tests.test_share_links_trashed_content import _auth, client, db  # noqa: F401  (fixtures)
import apps.api.tasks.cleanup_tasks as cleanup


class World:
    pass


def _seed(db):
    """Project P with members of every role. Asset A has ready v1 and v2, each
    with a media file, a timecoded comment and an approval; asset B has one
    ready v1. One share link to A shows the latest only, one all versions."""
    from apps.api.models.user import User
    from apps.api.models.project import Project, ProjectType, ProjectMember, ProjectRole
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, MediaFile, FileType, ProcessingStatus,
    )
    from apps.api.models.comment import Comment
    from apps.api.models.approval import Approval, ApprovalStatus
    from apps.api.models.share import ShareLink, SharePermission

    w = World()

    def user(name):
        u = User(email=f"{name}-{uuid.uuid4().hex[:8]}@t.local", name=name)
        db.add(u); db.flush(); db.refresh(u)
        return u

    w.owner, w.editor, w.reviewer, w.viewer, w.outsider = (
        user(n) for n in ("owner", "editor", "reviewer", "viewer", "outsider"))
    w.project = Project(name="P", project_type=ProjectType.team, created_by=w.owner.id)
    db.add(w.project); db.flush()
    for u, role in ((w.owner, ProjectRole.owner), (w.editor, ProjectRole.editor),
                    (w.reviewer, ProjectRole.reviewer), (w.viewer, ProjectRole.viewer)):
        db.add(ProjectMember(project_id=w.project.id, user_id=u.id, role=role))

    def asset(name, statuses):
        a = Asset(project_id=w.project.id, name=name, asset_type=AssetType.video,
                  created_by=w.owner.id, last_version_number=len(statuses))
        db.add(a); db.flush()
        versions = []
        for number, st in enumerate(statuses, start=1):
            v = AssetVersion(asset_id=a.id, version_number=number, processing_status=st,
                             created_by=w.owner.id)
            db.add(v); db.flush()
            db.add(MediaFile(version_id=v.id, file_type=FileType.video,
                             original_filename=f"{name}-v{number}.mov", mime_type="video/quicktime",
                             file_size_bytes=1000 * number,
                             s3_key_raw=f"raw/{a.id}/{v.id}/original.mov",
                             s3_key_processed=f"processed/{a.id}/{v.id}/master.m3u8",
                             s3_key_thumbnail=f"thumbs/{a.id}/{v.id}.jpg",
                             duration_seconds=12.0, fps=25.0))
            db.add(Comment(asset_id=a.id, version_id=v.id, author_id=w.owner.id,
                           body=f"{name} note on v{number}", timecode_start=1.0))
            db.add(Approval(asset_id=a.id, version_id=v.id, user_id=w.reviewer.id,
                            status=ApprovalStatus.approved))
            db.flush()
            versions.append(v)
        return a, versions

    ready = ProcessingStatus.ready
    w.A, (w.v1, w.v2) = asset("A", [ready, ready])
    w.B, (w.b1,) = asset("B", [ready])

    def link(show_versions):
        row = ShareLink(token=f"t-{uuid.uuid4().hex}", created_by=w.owner.id, title="A",
                        permission=SharePermission.comment, allow_download=True,
                        asset_id=w.A.id, show_versions=show_versions)
        db.add(row); db.flush()
        return row

    w.latest_only = link(show_versions=False)
    w.all_versions = link(show_versions=True)
    db.flush()
    return w


@pytest.fixture
def w(db):
    return _seed(db)


def _delete(client, w, version, user=None, asset=None):
    asset = asset or w.A
    return client.delete(f"/assets/{asset.id}/versions/{version.id}", headers=_auth(user or w.editor))


def _restore(client, w, version, user=None, asset=None):
    asset = asset or w.A
    return client.post(f"/assets/{asset.id}/versions/{version.id}/restore",
                       headers=_auth(user or w.editor))


def _ids(rows):
    return [r["id"] for r in rows]


# ── delete ───────────────────────────────────────────────────────────────────

def test_deleting_the_newest_version_answers_with_the_previous_as_latest(client, db, w):
    r = _delete(client, w, w.v2)

    assert r.status_code == 200, r.text
    latest = r.json()["latest_version"]
    assert latest["id"] == str(w.v1.id)
    assert latest["version_number"] == 1
    assert [f["original_filename"] for f in latest["files"]] == ["A-v1.mov"]

    versions = client.get(f"/assets/{w.A.id}/versions", headers=_auth(w.viewer)).json()
    assert _ids(versions) == [str(w.v1.id)]
    asset = client.get(f"/assets/{w.A.id}", headers=_auth(w.viewer)).json()
    assert asset["latest_version"]["id"] == str(w.v1.id)
    listed = client.get(f"/projects/{w.project.id}/assets", headers=_auth(w.viewer)).json()
    assert {a["id"]: a["latest_version"]["id"] for a in listed}[str(w.A.id)] == str(w.v1.id)
    db.expire_all()
    assert db.get(type(w.v2), w.v2.id).deleted_at is not None, "a soft delete keeps the row"


def test_deleting_an_older_version_leaves_the_latest_alone(client, w):
    r = _delete(client, w, w.v1, user=w.owner)

    assert r.status_code == 200, r.text
    assert r.json()["latest_version"]["id"] == str(w.v2.id)


@pytest.mark.parametrize("role", ["reviewer", "viewer", "outsider"])
def test_only_an_editor_or_above_may_delete_a_version(client, db, w, role):
    r = _delete(client, w, w.v2, user=getattr(w, role))

    assert r.status_code == 403, r.text
    db.expire_all()
    assert db.get(type(w.v2), w.v2.id).deleted_at is None


def test_a_version_already_deleted_is_not_found(client, w):
    assert _delete(client, w, w.v2).status_code == 200
    r = _delete(client, w, w.v2)
    assert (r.status_code, r.json()) == (404, {"detail": "Version not found"})


def test_a_version_of_another_asset_is_not_found(client, db, w):
    r = _delete(client, w, w.b1, asset=w.A)

    assert (r.status_code, r.json()) == (404, {"detail": "Version not found"})
    db.expire_all()
    assert db.get(type(w.b1), w.b1.id).deleted_at is None


def test_a_version_of_a_trashed_asset_is_not_found(client, w):
    assert client.delete(f"/assets/{w.A.id}", headers=_auth(w.editor)).status_code == 204
    r = _delete(client, w, w.v2)
    assert (r.status_code, r.json()) == (404, {"detail": "Asset not found"})


def test_the_only_version_is_refused_with_a_pointer_to_deleting_the_asset(client, db, w):
    r = _delete(client, w, w.b1, asset=w.B)

    assert r.status_code == 409, r.text
    assert r.json()["detail"] == (
        "No other version of this asset is ready or processing. Delete the asset instead.")
    db.expire_all()
    assert db.get(type(w.b1), w.b1.id).deleted_at is None
    assert db.get(type(w.B), w.B.id).deleted_at is None


def test_the_last_version_left_is_refused_once_the_other_is_gone(client, w):
    assert _delete(client, w, w.v2).status_code == 200
    r = _delete(client, w, w.v1)
    assert r.status_code == 409
    assert "Delete the asset instead" in r.json()["detail"]


def test_an_upload_in_flight_does_not_count_as_the_version_that_stays(client, db, w):
    """B: ready v1 beside an uploading v2. Discarding or reaping v2 would take the
    asset with it, so v1 is still the last version that landed."""
    from apps.api.models.asset import AssetVersion, ProcessingStatus

    db.add(AssetVersion(asset_id=w.B.id, version_number=2, created_by=w.owner.id,
                        processing_status=ProcessingStatus.uploading))
    db.flush()

    r = _delete(client, w, w.b1, asset=w.B)

    assert r.status_code == 409, r.text
    assert "Delete the asset instead" in r.json()["detail"]


def test_a_failed_version_does_not_count_as_the_version_that_stays(client, db, w):
    """The reaper reclaims a failed version whose master never assembled, and the
    asset with it, so a failed v1 cannot be what keeps the asset alive."""
    from apps.api.models.asset import ProcessingStatus

    w.v1.processing_status = ProcessingStatus.failed
    db.flush()

    r = _delete(client, w, w.v2)

    assert r.status_code == 409, r.text
    assert "Delete the asset instead" in r.json()["detail"]


def test_a_processing_version_does_count_as_the_version_that_stays(client, db, w):
    from apps.api.models.asset import ProcessingStatus

    w.v2.processing_status = ProcessingStatus.processing
    db.flush()

    r = _delete(client, w, w.v1)

    assert r.status_code == 200, r.text
    assert r.json()["latest_version"]["id"] == str(w.v2.id)


def test_a_failed_version_can_itself_be_deleted(client, db, w):
    from apps.api.models.asset import ProcessingStatus

    w.v2.processing_status = ProcessingStatus.failed
    db.flush()

    r = _delete(client, w, w.v2)

    assert r.status_code == 200, r.text
    assert r.json()["latest_version"]["id"] == str(w.v1.id)


def test_an_upload_in_flight_is_refused_with_a_pointer_to_discarding_it(client, db, w):
    from apps.api.models.asset import AssetVersion, ProcessingStatus

    up = AssetVersion(asset_id=w.A.id, version_number=3, created_by=w.owner.id,
                      processing_status=ProcessingStatus.uploading)
    db.add(up); db.flush()

    r = _delete(client, w, up)

    assert r.status_code == 409, r.text
    assert "Discard the upload instead" in r.json()["detail"]
    db.expire_all()
    assert db.get(AssetVersion, up.id).deleted_at is None


# ── restore ──────────────────────────────────────────────────────────────────

def test_restoring_the_newest_version_makes_it_latest_again(client, db, w):
    assert _delete(client, w, w.v2).status_code == 200

    r = _restore(client, w, w.v2)

    assert r.status_code == 200, r.text
    assert r.json()["latest_version"]["id"] == str(w.v2.id)
    versions = client.get(f"/assets/{w.A.id}/versions", headers=_auth(w.viewer)).json()
    assert _ids(versions) == [str(w.v2.id), str(w.v1.id)]
    db.expire_all()
    assert db.get(type(w.v2), w.v2.id).version_number == 2, "a restore keeps the number"


@pytest.mark.parametrize("role", ["reviewer", "viewer", "outsider"])
def test_only_an_editor_or_above_may_restore_a_version(client, db, w, role):
    assert _delete(client, w, w.v2).status_code == 200

    r = _restore(client, w, w.v2, user=getattr(w, role))

    assert r.status_code == 403, r.text
    db.expire_all()
    assert db.get(type(w.v2), w.v2.id).deleted_at is not None


def test_a_version_that_was_never_deleted_is_not_restorable(client, w):
    r = _restore(client, w, w.v2)
    assert (r.status_code, r.json()) == (404, {"detail": "Deleted version not found"})


def test_a_deleted_version_of_another_asset_is_not_restorable_here(client, db, w):
    assert _delete(client, w, w.v2).status_code == 200
    r = _restore(client, w, w.v2, asset=w.B)
    assert (r.status_code, r.json()) == (404, {"detail": "Deleted version not found"})
    db.expire_all()
    assert db.get(type(w.v2), w.v2.id).deleted_at is not None


def test_a_discarded_upload_is_not_restorable(client, db, w):
    """The discard path soft-deletes an `uploading` version and throws its bytes away."""
    from apps.api.models.asset import AssetVersion, ProcessingStatus

    up = AssetVersion(asset_id=w.A.id, version_number=3, created_by=w.owner.id,
                      processing_status=ProcessingStatus.uploading,
                      deleted_at=datetime.now(timezone.utc))
    db.add(up); db.flush()

    r = _restore(client, w, up)

    assert (r.status_code, r.json()) == (404, {"detail": "Deleted version not found"})
    db.expire_all()
    assert db.get(AssetVersion, up.id).deleted_at is not None


def test_a_processing_version_comes_back(client, db, w):
    from apps.api.models.asset import ProcessingStatus

    w.v2.processing_status = ProcessingStatus.processing
    db.flush()
    assert _delete(client, w, w.v2).status_code == 200

    assert _restore(client, w, w.v2).status_code == 200
    db.expire_all()
    assert db.get(type(w.v2), w.v2.id).deleted_at is None


def test_a_failed_version_is_refused_with_a_409(client, db, w):
    """It can be deleted, but not brought back: the reaper soft-deletes failed
    uploads that never assembled a file, and those must not come back as versions."""
    from apps.api.models.asset import ProcessingStatus

    w.v2.processing_status = ProcessingStatus.failed
    db.flush()
    assert _delete(client, w, w.v2).status_code == 200

    r = _restore(client, w, w.v2)

    assert (r.status_code, r.json()) == (409, {"detail": "A version that failed cannot be restored."})
    db.expire_all()
    assert db.get(type(w.v2), w.v2.id).deleted_at is not None


def test_a_version_the_purge_has_taken_is_not_restorable(client, db, w, monkeypatch):
    for name in ("delete_object", "delete_prefix", "abort_multipart_upload"):
        monkeypatch.setattr(cleanup, name, lambda *_: None)
    monkeypatch.setattr(cleanup.settings, "soft_delete_retention_days", 30)
    v2_id = w.v2.id
    assert _delete(client, w, w.v2).status_code == 200
    w.v2.deleted_at = datetime.now(timezone.utc) - timedelta(days=31)
    db.flush()

    counts = cleanup.PurgeCounts()
    cleanup._purge_soft_deleted(db, counts)
    db.flush()
    db.expire_all()

    assert counts.versions == 1 and counts.comments == 1 and counts.media_files == 1
    r = client.post(f"/assets/{w.A.id}/versions/{v2_id}/restore", headers=_auth(w.editor))
    assert (r.status_code, r.json()) == (404, {"detail": "Deleted version not found"})
    # The asset and its other version are untouched by the purge of one version.
    assert client.get(f"/assets/{w.A.id}", headers=_auth(w.viewer)).json()["latest_version"]["id"] == str(w.v1.id)


def test_a_deleted_version_inside_the_window_is_not_purged(client, db, w, monkeypatch):
    for name in ("delete_object", "delete_prefix", "abort_multipart_upload"):
        monkeypatch.setattr(cleanup, name, lambda *_: None)
    monkeypatch.setattr(cleanup.settings, "soft_delete_retention_days", 30)
    assert _delete(client, w, w.v2).status_code == 200

    cleanup._purge_soft_deleted(db, cleanup.PurgeCounts())
    db.flush()

    assert _restore(client, w, w.v2).status_code == 200


# ── what a deleted version leaves ────────────────────────────────────────────

def test_a_latest_only_share_link_moves_to_the_previous_version(client, w):
    token = w.latest_only.token
    before = client.get(f"/share/{token}/stream/{w.A.id}").json()
    assert before["version_id"] == str(w.v2.id)

    assert _delete(client, w, w.v2).status_code == 200

    after = client.get(f"/share/{token}/stream/{w.A.id}").json()
    assert after["version_id"] == str(w.v1.id)
    versions = client.get(f"/share/{token}/assets/{w.A.id}/versions").json()
    assert _ids(versions) == [str(w.v1.id)]
    assert _restore(client, w, w.v2).status_code == 200
    assert client.get(f"/share/{token}/stream/{w.A.id}").json()["version_id"] == str(w.v2.id)


def test_a_share_link_never_serves_a_deleted_version_asked_for_by_id(client, w):
    token = w.all_versions.token
    assert client.get(f"/share/{token}/stream/{w.A.id}?version_id={w.v1.id}").json()["version_id"] == str(w.v1.id)

    assert _delete(client, w, w.v1).status_code == 200

    asked = client.get(f"/share/{token}/stream/{w.A.id}?version_id={w.v1.id}")
    assert asked.status_code == 200
    assert asked.json()["version_id"] == str(w.v2.id), "the deleted v1 was served by id"
    downloads = client.get(f"/share/{token}/stream/{w.A.id}?version_id={w.v1.id}&download=true")
    assert downloads.json()["version_id"] == str(w.v2.id)
    versions = client.get(f"/share/{token}/assets/{w.A.id}/versions").json()
    assert _ids(versions) == [str(w.v2.id)]


def _bodies(rows):
    return sorted(c["body"] for c in rows)


def test_comments_on_a_deleted_version_leave_every_listing_and_come_back(client, w):
    viewer = _auth(w.viewer)
    assert _bodies(client.get(f"/assets/{w.A.id}/comments", headers=viewer).json()) == [
        "A note on v1", "A note on v2"]

    assert _delete(client, w, w.v2).status_code == 200

    assert _bodies(client.get(f"/assets/{w.A.id}/comments", headers=viewer).json()) == ["A note on v1"]
    assert client.get(f"/assets/{w.A.id}/comments?version_id={w.v2.id}", headers=viewer).json() == []
    for link in (w.latest_only, w.all_versions):
        assert _bodies(client.get(f"/share/{link.token}/comments").json()) == ["A note on v1"]
        assert client.get(f"/share/{link.token}/comments?version_id={w.v2.id}").json() == []
        assert _bodies(client.get(f"/share/{link.token}/comments?latest_only=true").json()) == ["A note on v1"]

    assert _restore(client, w, w.v2).status_code == 200
    assert _bodies(client.get(f"/assets/{w.A.id}/comments", headers=viewer).json()) == [
        "A note on v1", "A note on v2"]


def test_the_comment_export_of_a_deleted_version_is_not_found(client, w):
    viewer = _auth(w.viewer)
    assert _delete(client, w, w.v2).status_code == 200

    asked = client.get(f"/assets/{w.A.id}/comments/export?format=csv&version_id={w.v2.id}", headers=viewer)
    assert asked.status_code == 404
    latest = client.get(f"/assets/{w.A.id}/comments/export?format=csv", headers=viewer)
    assert latest.status_code == 200
    assert "A note on v1" in latest.text and "A note on v2" not in latest.text


def test_approvals_of_a_deleted_version_are_left_out_and_refused(client, w):
    viewer = _auth(w.viewer)
    assert _delete(client, w, w.v2).status_code == 200

    listed = client.get(f"/assets/{w.A.id}/approvals", headers=viewer).json()
    assert [a["version_id"] for a in listed] == [str(w.v1.id)]
    r = client.post(f"/assets/{w.A.id}/approve", json={"version_id": str(w.v2.id)},
                    headers=_auth(w.reviewer))
    assert r.status_code == 400, r.text

    assert _restore(client, w, w.v2).status_code == 200
    listed = client.get(f"/assets/{w.A.id}/approvals", headers=viewer).json()
    assert sorted(a["version_id"] for a in listed) == sorted([str(w.v1.id), str(w.v2.id)])


def test_approving_a_version_of_another_asset_is_refused(client, w):
    r = client.post(f"/assets/{w.A.id}/approve", json={"version_id": str(w.b1.id)},
                    headers=_auth(w.reviewer))
    assert r.status_code == 400, r.text


def test_the_storage_count_leaves_out_a_deleted_version_until_restored(client, db, w):
    from apps.api.services.storage import instance_storage_used_bytes

    before = instance_storage_used_bytes(db)
    assert _delete(client, w, w.v2).status_code == 200
    assert instance_storage_used_bytes(db) == before - 2000
    assert _restore(client, w, w.v2).status_code == 200
    assert instance_storage_used_bytes(db) == before


# ── two deletes at once ──────────────────────────────────────────────────────

@pytest.fixture
def committed_pair():
    """Asset with two ready versions and an editor, committed so a second
    connection sees them; removed afterwards."""
    from apps.api.database import engine
    from apps.api.models.asset import Asset, AssetType, AssetVersion, ProcessingStatus
    from apps.api.models.project import Project, ProjectMember, ProjectRole, ProjectType
    from apps.api.models.user import User

    with engine.connect() as conn:
        s = _SASession(bind=conn)
        user = User(id=uuid.uuid4(), email=f"pair-{uuid.uuid4().hex[:8]}@example.test", name="Pair")
        s.add(user); s.flush()
        project = Project(id=uuid.uuid4(), name="pair", project_type=ProjectType.team, created_by=user.id)
        s.add(project); s.flush()
        s.add(ProjectMember(project_id=project.id, user_id=user.id, role=ProjectRole.editor))
        asset = Asset(id=uuid.uuid4(), project_id=project.id, name="clip",
                      asset_type=AssetType.video, created_by=user.id, last_version_number=2)
        s.add(asset); s.flush()
        versions = [AssetVersion(id=uuid.uuid4(), asset_id=asset.id, version_number=n,
                                 processing_status=ProcessingStatus.ready, created_by=user.id)
                    for n in (1, 2)]
        s.add_all(versions)
        s.commit()
        ids = {"user": user.id, "project": project.id, "asset": asset.id,
               "versions": [v.id for v in versions]}

    yield ids

    with engine.connect() as conn:
        s = _SASession(bind=conn)
        s.query(AssetVersion).filter(AssetVersion.asset_id == ids["asset"]).delete()
        s.query(Asset).filter(Asset.id == ids["asset"]).delete()
        s.query(ProjectMember).filter(ProjectMember.project_id == ids["project"]).delete()
        s.query(Project).filter(Project.id == ids["project"]).delete()
        s.query(User).filter(User.id == ids["user"]).delete()
        s.commit()


def test_two_deletes_of_the_last_two_versions_cannot_both_succeed(committed_pair):
    """The first delete holds the asset's row lock; the second waits for it, and
    then sees that its version is the only one left."""
    from fastapi import HTTPException
    from apps.api.database import engine
    from apps.api.models.user import User
    import apps.api.routers.assets as assets_module

    v1, v2 = committed_pair["versions"]
    with engine.connect() as conn_a, engine.connect() as conn_b:
        a = _SASession(bind=conn_a)
        b = _SASession(bind=conn_b)
        try:
            user_a = a.get(User, committed_pair["user"])
            user_b = b.get(User, committed_pair["user"])
            real_commit = a.commit
            a.commit = lambda: a.flush()  # hold the first delete's transaction open
            first = assets_module.delete_asset_version(
                committed_pair["asset"], v1, db=a, current_user=user_a)
            assert first.latest_version.id == v2

            outcome = []
            def second():
                try:
                    assets_module.delete_asset_version(
                        committed_pair["asset"], v2, db=b, current_user=user_b)
                    outcome.append(200)
                except HTTPException as exc:
                    outcome.append(exc.status_code)
                    b.rollback()
            racer = threading.Thread(target=second)
            racer.start()
            racer.join(timeout=1.0)
            assert racer.is_alive(), "the second delete did not wait for the first"

            real_commit()
            racer.join(timeout=10.0)
            assert outcome == [409]
        finally:
            a.rollback()
            b.rollback()
            a.close()
            b.close()


def test_a_restore_that_loses_the_race_to_the_purge_answers_404(committed_pair, monkeypatch):
    """The purge has locked and deleted the version but not committed yet. The
    restore still reads the row, waits on its lock, and then finds it gone (#115)."""
    from fastapi import HTTPException
    from apps.api.database import engine
    from apps.api.models.asset import AssetVersion
    from apps.api.models.user import User
    import apps.api.routers.assets as assets_module

    for name in ("delete_object", "delete_prefix", "abort_multipart_upload"):
        monkeypatch.setattr(cleanup, name, lambda *_: None)
    _, v2 = committed_pair["versions"]
    with engine.connect() as conn_p, engine.connect() as conn_r:
        purger = _SASession(bind=conn_p)
        restorer = _SASession(bind=conn_r)
        try:
            purger.get(AssetVersion, v2).deleted_at = datetime(2024, 1, 1, tzinfo=timezone.utc)
            purger.commit()
            cutoff = datetime.now(timezone.utc) - timedelta(days=30)
            assert cleanup._lock_if_still_purgeable(purger, AssetVersion, v2, cutoff) is not None
            cleanup._purge_version(purger, v2, cleanup.PurgeCounts())

            outcome = []
            def restore():
                try:
                    assets_module.restore_asset_version(
                        committed_pair["asset"], v2, db=restorer,
                        current_user=restorer.get(User, committed_pair["user"]))
                    outcome.append(200)
                except HTTPException as exc:
                    outcome.append((exc.status_code, exc.detail))
            racer = threading.Thread(target=restore)
            racer.start()
            racer.join(timeout=1.0)
            assert racer.is_alive(), "the restore did not wait on the purge's lock"

            purger.commit()
            racer.join(timeout=10.0)
            assert outcome == [(404, "Deleted version not found")]
        finally:
            purger.rollback()
            restorer.rollback()
            purger.close()
            restorer.close()
