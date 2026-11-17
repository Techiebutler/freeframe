"""Setting one version of an asset as its current version.

`PUT /assets/{asset_id}/current-version` makes a version other than the newest
the one that stands for the asset. Guarded here, each against a real Postgres
through the real app:
  * an editor or owner may set a ready version, nobody below (403); a version
    that is not the asset's or is deleted is not found (404), one that is not
    ready is refused (409);
  * setting the version that is current by default stores nothing;
  * everything that resolves "the latest" follows it: the asset and the grid
    (version, thumbnail, comment count), the version list's `is_current`, the
    stream and download without a version, the comment export, share links
    that show the latest only (stream, thumbnail, versions, comments, the
    share grid's count) and a guest comment without a version;
  * a share link showing all versions still lists them all;
  * a newer version that becomes ready ends the setting, through the
    transcode and through the stuck-processing sweep; an upload still in
    flight does not, nor does an older version becoming ready;
  * deleting the version set as current ends the setting and the answer says
    so; restoring it does not bring the setting back;
  * the migration adds the column with `ON DELETE SET NULL`, and goes back down.
"""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from apps.api.tests.test_share_links_trashed_content import _auth, client, db  # noqa: F401  (fixtures)
from apps.api.tests.test_delete_a_version import _seed, _delete, _restore, _ids


@pytest.fixture
def w(db):
    """`test_delete_a_version._seed` (asset A with ready v1 and v2), plus a
    second comment on v1 so the two versions' comment counts differ, and a
    folder link to a folder holding A, for the share grid."""
    from apps.api.models.comment import Comment
    from apps.api.models.folder import Folder
    from apps.api.models.share import ShareLink, SharePermission

    w = _seed(db)
    db.add(Comment(asset_id=w.A.id, version_id=w.v1.id, author_id=w.owner.id,
                   body="A second note on v1", timecode_start=2.0))
    w.F = Folder(project_id=w.project.id, name="F", created_by=w.owner.id)
    db.add(w.F); db.flush()
    w.A.folder_id = w.F.id
    w.folder_link = ShareLink(token=f"f-{uuid.uuid4().hex}", created_by=w.owner.id, title="F",
                              permission=SharePermission.comment, allow_download=True,
                              folder_id=w.F.id)
    db.add(w.folder_link)
    db.flush()
    return w


def _set(client, w, version, user=None, asset=None):
    asset = asset or w.A
    return client.put(f"/assets/{asset.id}/current-version", json={"version_id": str(version.id)},
                      headers=_auth(user or w.editor))


def _pin(db, w):
    db.expire_all()
    return db.get(type(w.A), w.A.id).current_version_id


def _add_version(db, w, number, status):
    """A further version of A, as an upload would create it."""
    from apps.api.models.asset import AssetVersion, MediaFile, FileType

    v = AssetVersion(asset_id=w.A.id, version_number=number, processing_status=status,
                     created_by=w.owner.id)
    db.add(v); db.flush()
    db.add(MediaFile(version_id=v.id, file_type=FileType.video,
                     original_filename=f"A-v{number}.mov", mime_type="video/quicktime",
                     file_size_bytes=1000, s3_key_raw=f"raw/{w.A.id}/{v.id}/original.mov",
                     s3_key_processed=f"processed/{w.A.id}/{v.id}/master.m3u8",
                     s3_key_thumbnail=f"thumbs/{w.A.id}/{v.id}.jpg", duration_seconds=12.0))
    w.A.last_version_number = number
    db.flush()
    return v


# ── setting it ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("who", ["editor", "owner"])
def test_an_editor_or_owner_sets_an_older_version_as_current(client, db, w, who):
    r = _set(client, w, w.v1, user=getattr(w, who))

    assert r.status_code == 200, r.text
    latest = r.json()["latest_version"]
    assert latest["id"] == str(w.v1.id)
    assert [f["original_filename"] for f in latest["files"]] == ["A-v1.mov"]
    assert _pin(db, w) == w.v1.id


@pytest.mark.parametrize("role", ["reviewer", "viewer", "outsider"])
def test_nobody_below_editor_may_set_the_current_version(client, db, w, role):
    r = _set(client, w, w.v1, user=getattr(w, role))

    assert r.status_code == 403, r.text
    assert _pin(db, w) is None


def test_a_version_of_another_asset_is_not_found(client, db, w):
    r = _set(client, w, w.b1)

    assert r.status_code == 404, r.text
    assert r.json()["detail"] == "Version not found"
    assert _pin(db, w) is None


def test_an_unknown_version_is_not_found(client, w):
    r = client.put(f"/assets/{w.A.id}/current-version", json={"version_id": str(uuid.uuid4())},
                   headers=_auth(w.editor))
    assert r.status_code == 404, r.text


def test_a_deleted_version_is_not_found(client, db, w):
    assert _delete(client, w, w.v1).status_code == 200

    r = _set(client, w, w.v1)

    assert r.status_code == 404, r.text
    assert _pin(db, w) is None


def test_a_trashed_asset_is_not_found(client, w):
    assert client.delete(f"/assets/{w.A.id}", headers=_auth(w.editor)).status_code == 204
    assert _set(client, w, w.v1).status_code == 404


@pytest.mark.parametrize("status", ["processing", "failed", "uploading"])
def test_only_a_ready_version_can_be_set(client, db, w, status):
    from apps.api.models.asset import ProcessingStatus

    w.v1.processing_status = ProcessingStatus(status)
    db.flush()

    r = _set(client, w, w.v1)

    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "Only a version that is ready can be the current version."
    assert _pin(db, w) is None


def test_setting_the_version_that_is_current_by_default_stores_nothing(client, db, w):
    r = _set(client, w, w.v2)
    assert r.status_code == 200, r.text
    assert r.json()["latest_version"]["id"] == str(w.v2.id)
    assert _pin(db, w) is None

    # And so it is how a setting is taken back.
    assert _set(client, w, w.v1).status_code == 200
    assert _pin(db, w) == w.v1.id
    r = _set(client, w, w.v2)
    assert r.json()["latest_version"]["id"] == str(w.v2.id)
    assert _pin(db, w) is None


def test_setting_it_again_keeps_it(client, db, w):
    assert _set(client, w, w.v1).status_code == 200
    assert _set(client, w, w.v1).status_code == 200
    assert _pin(db, w) == w.v1.id


def test_a_ready_version_below_one_still_processing_is_kept_as_set(client, db, w):
    """The default shows a processing v3; v2, ready below it, is a real choice."""
    from apps.api.models.asset import ProcessingStatus

    _add_version(db, w, 3, ProcessingStatus.processing)
    assert client.get(f"/assets/{w.A.id}", headers=_auth(w.viewer)).json()["latest_version"]["version_number"] == 3

    r = _set(client, w, w.v2)

    assert r.json()["latest_version"]["id"] == str(w.v2.id)
    assert _pin(db, w) == w.v2.id


# ── everything that resolves "the latest" follows it ─────────────────────────

def test_the_asset_and_the_grid_show_the_version_set_as_current(client, w):
    viewer = _auth(w.viewer)
    before = client.get(f"/assets/{w.A.id}", headers=viewer).json()
    assert (before["latest_version"]["id"], before["comment_count"]) == (str(w.v2.id), 1)

    assert _set(client, w, w.v1).status_code == 200

    asset = client.get(f"/assets/{w.A.id}", headers=viewer).json()
    assert asset["latest_version"]["id"] == str(w.v1.id)
    assert asset["comment_count"] == 2
    assert str(w.v1.id) in asset["thumbnail_url"]
    for path in (f"/projects/{w.project.id}/assets?folder_id={w.F.id}",
                 f"/assets/batch?ids={w.A.id}&ids={w.B.id}"):
        listed = {a["id"]: a for a in client.get(path, headers=viewer).json()}
        a = listed[str(w.A.id)]
        assert a["latest_version"]["id"] == str(w.v1.id), path
        assert a["comment_count"] == 2, path
        assert str(w.v1.id) in a["thumbnail_url"], path
    # Other assets keep the default.
    b = client.get(f"/assets/{w.B.id}", headers=viewer).json()
    assert b["latest_version"]["id"] == str(w.b1.id)


def test_the_version_list_marks_the_current_version(client, w):
    viewer = _auth(w.viewer)
    rows = client.get(f"/assets/{w.A.id}/versions", headers=viewer).json()
    assert {r["version_number"]: r["is_current"] for r in rows} == {1: False, 2: True}

    assert _set(client, w, w.v1).status_code == 200

    rows = client.get(f"/assets/{w.A.id}/versions", headers=viewer).json()
    assert _ids(rows) == [str(w.v2.id), str(w.v1.id)], "still newest first"
    assert {r["version_number"]: r["is_current"] for r in rows} == {1: True, 2: False}


def test_a_version_still_processing_is_never_marked_current(client, db, w):
    """The grid shows a processing v3, but share links and the player open
    with v2, and that is the one marked current."""
    from apps.api.models.asset import ProcessingStatus

    _add_version(db, w, 3, ProcessingStatus.processing)

    rows = client.get(f"/assets/{w.A.id}/versions", headers=_auth(w.viewer)).json()
    assert [r["version_number"] for r in rows if r["is_current"]] == [2]
    grid = client.get(f"/assets/{w.A.id}", headers=_auth(w.viewer)).json()
    assert grid["latest_version"]["version_number"] == 3


def test_the_stream_download_and_export_without_a_version_follow_it(client, w):
    viewer = _auth(w.viewer)
    assert _set(client, w, w.v1).status_code == 200

    download = client.get(f"/assets/{w.A.id}/stream?download=true", headers=viewer)
    assert download.status_code == 200, download.text
    assert str(w.v1.id) in download.json()["url"]
    options = client.get(f"/assets/{w.A.id}/downloads", headers=viewer)
    assert options.status_code == 200, options.text
    assert [o["size_bytes"] for o in options.json()] == [1000], "v1's file, not v2's 2000 bytes"
    export = client.get(f"/assets/{w.A.id}/comments/export?format=csv", headers=viewer)
    assert export.status_code == 200, export.text
    assert "A note on v1" in export.text and "A note on v2" not in export.text
    # Naming a version still gets that version.
    named = client.get(f"/assets/{w.A.id}/stream?download=true&version_id={w.v2.id}", headers=viewer)
    assert str(w.v2.id) in named.json()["url"]


def test_a_latest_only_share_link_shows_the_version_set_as_current(client, w):
    token = w.latest_only.token
    assert client.get(f"/share/{token}/stream/{w.A.id}").json()["version_id"] == str(w.v2.id)

    assert _set(client, w, w.v1).status_code == 200

    assert client.get(f"/share/{token}/stream/{w.A.id}").json()["version_id"] == str(w.v1.id)
    assert client.get(f"/share/{token}/stream/{w.A.id}?download=true").json()["version_id"] == str(w.v1.id)
    assert str(w.v1.id) in client.get(f"/share/{token}/thumbnail/{w.A.id}").json()["url"]
    assert _ids(client.get(f"/share/{token}/assets/{w.A.id}/versions").json()) == [str(w.v1.id)]
    page = client.get(f"/share/{token}").json()
    assert str(w.v1.id) in page["asset"]["thumbnail_url"]
    comments = client.get(f"/share/{token}/comments?latest_only=true").json()
    assert sorted(c["body"] for c in comments) == ["A note on v1", "A second note on v1"]


def test_a_latest_only_share_link_ignores_a_version_named_by_id(client, w):
    """A link that shows the latest only never serves another version, even
    to someone who knows its id: not to watch, not to download."""
    token = w.latest_only.token
    assert _set(client, w, w.v1).status_code == 200

    for path in (f"/share/{token}/stream/{w.A.id}?version_id={w.v2.id}",
                 f"/share/{token}/stream/{w.A.id}?version_id={w.v2.id}&download=true"):
        r = client.get(path)
        assert r.status_code == 200, r.text
        assert r.json()["version_id"] == str(w.v1.id), path
    assert _ids(client.get(f"/share/{token}/assets/{w.A.id}/versions").json()) == [str(w.v1.id)]


@pytest.mark.parametrize("status", ["processing", "uploading", "failed"])
def test_a_latest_only_share_link_never_shows_an_unfinished_newest_version(client, db, w, status):
    """With nothing set as current, a newer version that is not ready does not
    reach the link: it goes on showing the newest ready one."""
    from apps.api.models.asset import ProcessingStatus
    from apps.api.models.comment import Comment

    v3 = _add_version(db, w, 3, ProcessingStatus(status))
    db.add(Comment(asset_id=w.A.id, version_id=v3.id, author_id=w.owner.id,
                   body="A note on v3", timecode_start=1.0))
    db.flush()
    token = w.latest_only.token

    assert client.get(f"/share/{token}/stream/{w.A.id}").json()["version_id"] == str(w.v2.id)
    assert str(w.v2.id) in client.get(f"/share/{token}/thumbnail/{w.A.id}").json()["url"]
    assert _ids(client.get(f"/share/{token}/assets/{w.A.id}/versions").json()) == [str(w.v2.id)]
    comments = client.get(f"/share/{token}/comments?latest_only=true").json()
    assert [c["body"] for c in comments] == ["A note on v2"]


def test_the_share_grid_counts_the_comments_of_the_version_set_as_current(client, w):
    token = w.folder_link.token
    def card():
        rows = client.get(f"/share/{token}/assets").json()["assets"]
        return next(a for a in rows if a["id"] == str(w.A.id))
    assert card()["comment_count"] == 1

    assert _set(client, w, w.v1).status_code == 200

    assert card()["comment_count"] == 2
    assert str(w.v1.id) in card()["thumbnail_url"]


def test_a_share_link_showing_all_versions_still_lists_them_all(client, w):
    token = w.all_versions.token
    assert _set(client, w, w.v1).status_code == 200

    assert _ids(client.get(f"/share/{token}/assets/{w.A.id}/versions").json()) == [
        str(w.v2.id), str(w.v1.id)]
    # It opens on the current one, and a version asked for by id still plays.
    assert client.get(f"/share/{token}/stream/{w.A.id}").json()["version_id"] == str(w.v1.id)
    asked = client.get(f"/share/{token}/stream/{w.A.id}?version_id={w.v2.id}").json()
    assert asked["version_id"] == str(w.v2.id)


def test_a_guest_comment_without_a_version_lands_on_the_version_set_as_current(client, db, w):
    from apps.api.models.comment import Comment

    assert _set(client, w, w.v1).status_code == 200

    r = client.post(f"/share/{w.latest_only.token}/comment",
                    json={"body": "from the client", "guest_email": "g@t.local", "guest_name": "G"})

    assert r.status_code == 201, r.text
    db.expire_all()
    assert db.get(Comment, uuid.UUID(r.json()["id"])).version_id == w.v1.id


# ── what ends it ─────────────────────────────────────────────────────────────

def _transcode(db, version):
    """Run the real `process_asset` on `version` against the test session, with
    the transcode itself stubbed out: the version ends up ready."""
    from apps.api.tasks import transcode_tasks

    task = transcode_tasks.process_asset
    task = getattr(task, "_get_current_object", lambda: task)()
    task.push_request(retries=0, called_directly=False)
    try:
        with patch.object(transcode_tasks, "SessionLocal", return_value=db), \
             patch.object(db, "close"), \
             patch.object(transcode_tasks, "get_s3_client", return_value=MagicMock()), \
             patch.object(transcode_tasks, "_process_video"), \
             patch.object(transcode_tasks, "_publish_event"):
            task.run(str(version.asset_id), str(version.id))
    finally:
        task.pop_request()


def test_a_new_upload_ends_it_once_it_is_ready(client, db, w):
    from apps.api.models.asset import ProcessingStatus

    assert _set(client, w, w.v1).status_code == 200
    v3 = _add_version(db, w, 3, ProcessingStatus.uploading)
    # While it uploads and transcodes, the version set stays current.
    assert _pin(db, w) == w.v1.id
    v3.processing_status = ProcessingStatus.processing
    db.flush()
    asset = client.get(f"/assets/{w.A.id}", headers=_auth(w.viewer)).json()
    assert asset["latest_version"]["id"] == str(w.v1.id)
    assert client.get(f"/share/{w.latest_only.token}/stream/{w.A.id}").json()["version_id"] == str(w.v1.id)

    _transcode(db, v3)

    db.expire_all()
    assert db.get(type(v3), v3.id).processing_status == ProcessingStatus.ready
    assert _pin(db, w) is None
    asset = client.get(f"/assets/{w.A.id}", headers=_auth(w.viewer)).json()
    assert asset["latest_version"]["id"] == str(v3.id)
    assert client.get(f"/share/{w.latest_only.token}/stream/{w.A.id}").json()["version_id"] == str(v3.id)


def test_a_newer_version_deleted_while_it_transcodes_does_not_end_it(client, db, w):
    """v1 is set, v3 is uploaded and deleted while it transcodes. The transcode
    still finishes and marks v3 ready; the share link must go on showing v1,
    not fall back to the newest live version, v2."""
    from apps.api.models.asset import ProcessingStatus

    assert _set(client, w, w.v1).status_code == 200
    v3 = _add_version(db, w, 3, ProcessingStatus.processing)
    assert _delete(client, w, v3).status_code == 200

    _transcode(db, v3)

    db.expire_all()
    assert db.get(type(v3), v3.id).processing_status == ProcessingStatus.ready
    assert _pin(db, w) == w.v1.id
    assert client.get(f"/share/{w.latest_only.token}/stream/{w.A.id}").json()["version_id"] == str(w.v1.id)
    # Restoring it afterwards does not end the setting either.
    assert _restore(client, w, v3).status_code == 200
    assert _pin(db, w) == w.v1.id


def test_a_newer_version_deleted_elsewhere_during_the_encode_does_not_end_it(client, db, w):
    """The realistic order: the transcode has loaded v3, and while ffmpeg runs
    the API deletes it in its own transaction. The worker's copy of v3 still
    says live, so the check has to be made by the database."""
    from sqlalchemy import text
    from apps.api.models.asset import ProcessingStatus
    from apps.api.tasks import transcode_tasks

    assert _set(client, w, w.v1).status_code == 200
    v3 = _add_version(db, w, 3, ProcessingStatus.processing)

    def encode(_db, _asset, version, *a, **k):
        assert version.deleted_at is None  # loaded before the delete
        # The API's delete, past this session's identity map.
        db.execute(text("UPDATE asset_versions SET deleted_at = now() WHERE id = :v"), {"v": version.id})

    task = transcode_tasks.process_asset
    task = getattr(task, "_get_current_object", lambda: task)()
    task.push_request(retries=0, called_directly=False)
    try:
        with patch.object(transcode_tasks, "SessionLocal", return_value=db), \
             patch.object(db, "close"), \
             patch.object(transcode_tasks, "get_s3_client", return_value=MagicMock()), \
             patch.object(transcode_tasks, "_process_video", side_effect=encode), \
             patch.object(transcode_tasks, "_publish_event"):
            task.run(str(v3.asset_id), str(v3.id))
    finally:
        task.pop_request()

    db.expire_all()
    assert db.get(type(v3), v3.id).deleted_at is not None
    assert _pin(db, w) == w.v1.id
    assert client.get(f"/share/{w.latest_only.token}/stream/{w.A.id}").json()["version_id"] == str(w.v1.id)


def test_a_new_upload_that_fails_leaves_it(client, db, w):
    from apps.api.models.asset import ProcessingStatus
    from apps.api.tasks import transcode_tasks

    assert _set(client, w, w.v1).status_code == 200
    v3 = _add_version(db, w, 3, ProcessingStatus.processing)

    task = transcode_tasks.process_asset
    task = getattr(task, "_get_current_object", lambda: task)()
    task.push_request(retries=3, called_directly=False)
    try:
        with patch.object(transcode_tasks, "SessionLocal", return_value=db), \
             patch.object(db, "close"), \
             patch.object(transcode_tasks, "get_s3_client", return_value=MagicMock()), \
             patch.object(transcode_tasks, "_process_video", side_effect=RuntimeError("no")), \
             patch.object(transcode_tasks, "_publish_event"):
            with pytest.raises(RuntimeError):
                task.run(str(v3.asset_id), str(v3.id))
    finally:
        task.pop_request()

    db.expire_all()
    assert db.get(type(v3), v3.id).processing_status == ProcessingStatus.failed
    assert _pin(db, w) == w.v1.id


def test_a_newer_version_the_sweep_marks_ready_ends_it(client, db, w):
    from apps.api.models.asset import ProcessingStatus
    from apps.api.tasks import cleanup_tasks

    assert _set(client, w, w.v1).status_code == 200
    v3 = _add_version(db, w, 3, ProcessingStatus.processing)
    v3.last_activity_at = datetime.now(timezone.utc) - timedelta(days=2)
    db.flush()

    with patch.object(cleanup_tasks.settings, "stuck_processing_timeout_hours", 6), \
         patch.object(cleanup_tasks, "SessionLocal", return_value=db), \
         patch.object(db, "close"), \
         patch("apps.api.tasks.celery_app.send_task_safe"):
        cleanup_tasks.requeue_stuck_processing()

    db.expire_all()
    assert db.get(type(v3), v3.id).processing_status == ProcessingStatus.ready
    assert _pin(db, w) is None


def test_an_older_version_becoming_ready_leaves_it(client, db, w):
    """Only a version numbered above the one set takes over."""
    from apps.api.models.asset import ProcessingStatus

    _add_version(db, w, 3, ProcessingStatus.ready)
    assert _set(client, w, w.v2).status_code == 200
    w.v1.processing_status = ProcessingStatus.processing
    db.flush()

    _transcode(db, w.v1)

    db.expire_all()
    assert db.get(type(w.v1), w.v1.id).processing_status == ProcessingStatus.ready
    assert _pin(db, w) == w.v2.id


def test_the_setting_is_per_asset(client, db, w):
    """Another asset's version becoming ready leaves it alone."""
    from apps.api.models.asset import ProcessingStatus

    assert _set(client, w, w.v1).status_code == 200
    w.b1.processing_status = ProcessingStatus.processing
    w.b1.version_number = 9
    db.flush()

    _transcode(db, w.b1)

    assert _pin(db, w) == w.v1.id


def test_deleting_the_version_set_as_current_ends_it_and_restoring_does_not_bring_it_back(client, db, w):
    from apps.api.models.asset import ProcessingStatus

    _add_version(db, w, 3, ProcessingStatus.ready)
    assert _set(client, w, w.v1).status_code == 200

    r = _delete(client, w, w.v1)

    assert r.status_code == 200, r.text
    assert r.json()["latest_version"]["version_number"] == 3
    assert _pin(db, w) is None

    r = _restore(client, w, w.v1)
    assert r.status_code == 200, r.text
    assert r.json()["latest_version"]["version_number"] == 3
    assert _pin(db, w) is None


def test_deleting_another_version_keeps_it(client, db, w):
    from apps.api.models.asset import ProcessingStatus

    _add_version(db, w, 3, ProcessingStatus.ready)
    assert _set(client, w, w.v1).status_code == 200

    r = _delete(client, w, w.v2)

    assert r.json()["latest_version"]["id"] == str(w.v1.id)
    assert _pin(db, w) == w.v1.id


def test_a_version_set_as_current_deleted_elsewhere_falls_back_and_the_purge_clears_it(client, db, w, monkeypatch):
    """A soft delete that bypasses the endpoint (the admin trash, a script)
    leaves the setting behind: it is ignored while the row is in the trash, and
    `ON DELETE SET NULL` clears it when the purge takes the row."""
    import apps.api.tasks.cleanup_tasks as cleanup

    for name in ("delete_object", "delete_prefix", "abort_multipart_upload"):
        monkeypatch.setattr(cleanup, name, lambda *_: None)
    monkeypatch.setattr(cleanup.settings, "soft_delete_retention_days", 30)
    assert _set(client, w, w.v1).status_code == 200
    w.v1.deleted_at = datetime.now(timezone.utc) - timedelta(days=31)
    db.flush()

    viewer = _auth(w.viewer)
    assert client.get(f"/assets/{w.A.id}", headers=viewer).json()["latest_version"]["id"] == str(w.v2.id)
    grid = client.get(f"/projects/{w.project.id}/assets?folder_id={w.F.id}", headers=viewer).json()
    assert [a["latest_version"]["id"] for a in grid] == [str(w.v2.id)]
    assert client.get(f"/share/{w.latest_only.token}/stream/{w.A.id}").json()["version_id"] == str(w.v2.id)
    rows = client.get(f"/assets/{w.A.id}/versions", headers=viewer).json()
    assert {r["version_number"]: r["is_current"] for r in rows} == {2: True}

    counts = cleanup.PurgeCounts()
    cleanup._purge_soft_deleted(db, counts)
    db.flush()

    assert counts.versions == 1
    assert _pin(db, w) is None


def test_the_purge_takes_an_asset_whose_version_is_set_as_current(client, db, w, monkeypatch):
    """The asset points at its own version: purging both must not trip on the key."""
    import apps.api.tasks.cleanup_tasks as cleanup
    from apps.api.models.asset import Asset

    for name in ("delete_object", "delete_prefix", "abort_multipart_upload"):
        monkeypatch.setattr(cleanup, name, lambda *_: None)
    monkeypatch.setattr(cleanup.settings, "soft_delete_retention_days", 30)
    assert _set(client, w, w.v1).status_code == 200
    asset_id = w.A.id
    w.A.deleted_at = datetime.now(timezone.utc) - timedelta(days=31)
    db.flush()

    counts = cleanup.PurgeCounts()
    cleanup._purge_soft_deleted(db, counts)
    db.flush()
    db.expire_all()

    assert counts.assets == 1
    assert db.query(Asset).filter(Asset.id == asset_id).count() == 0


# ── migration ────────────────────────────────────────────────────────────────

def _load_migration():
    import importlib.util
    import pathlib

    path = (pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions"
            / "9d2e5b7c41a8_add_current_version_id_to_assets.py")
    spec = importlib.util.spec_from_file_location("add_current_version_id_to_assets", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_migration_adds_the_column_with_set_null_and_goes_back_down(db):
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import text

    mod = _load_migration()
    assert mod.down_revision == "74cc6317c7f9"

    def column():
        return db.execute(text(
            "SELECT is_nullable FROM information_schema.columns "
            "WHERE table_name = 'assets' AND column_name = 'current_version_id'"
        )).scalar()

    def on_delete():
        return db.execute(text(
            "SELECT confdeltype FROM pg_constraint WHERE conname = 'fk_assets_current_version_id'"
        )).scalar()

    assert (column(), on_delete()) == ("YES", "n")  # n: SET NULL
    def run(step):
        with Operations.context(MigrationContext.configure(db.connection())):
            step()

    run(mod.downgrade)
    assert (column(), on_delete()) == (None, None)
    run(mod.upgrade)
    assert (column(), on_delete()) == ("YES", "n")
