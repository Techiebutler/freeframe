"""Discarding an upload is not the same as one that failed.

A plain abort marks the version `failed`, which is right for a transfer that
gave up and wrong for one somebody threw away on purpose: the asset then carries
a red "Failed" badge in the version switcher for an upload nobody wanted. And
when the object happens to be assembled, abort takes its own branch and
*publishes* it -- so the one control that exists to discard an upload did the
opposite. Found by hand on a dev instance.

These run against real Postgres, and they check what was *committed*, not what
the session happens to hold. The storage deletes go out before the commit, so a
lost commit is not a no-op: the endpoint would answer 204 with the bytes gone
and the version row still live, pointing at nothing. A session that reads its
own unflushed writes cannot see that, which is how an earlier MagicMock version
of this file stayed green with the commit replaced by `pass`.
"""
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

import apps.api.routers.folders as folders_module
import apps.api.routers.upload as upload_module
import apps.api.tasks.cleanup_tasks as cleanup
from apps.api.models.asset import (
    Asset, AssetType, AssetVersion, FileType, MediaFile, ProcessingStatus,
)
from apps.api.models.project import Project, ProjectMember, ProjectRole, ProjectType
from apps.api.models.user import User
from apps.api.schemas.upload import AbortUploadRequest

MB = 1024 * 1024


@pytest.fixture
def db():
    """A real session whose `commit()` is observable.

    The shared `real_db` fixture joins the outer transaction, so a commit there
    does nothing a test can tell apart from no commit. Here every session
    transaction is a SAVEPOINT: `commit()` releases it and `rollback()` returns
    to it, so rolling back after the call throws away exactly what the endpoint
    did not commit. The outer transaction still rolls everything back at the end.
    """
    from apps.api.database import engine
    conn = engine.connect()
    trans = conn.begin()
    session = Session(bind=conn, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        trans.rollback()
        conn.close()


@pytest.fixture
def storage(monkeypatch):
    """Records what the endpoint asked storage to do."""
    calls = {"aborted": [], "deleted": []}
    abort = lambda k, u: calls["aborted"].append((k, u))
    monkeypatch.setattr(upload_module, "abort_multipart_upload", abort)
    monkeypatch.setattr(cleanup, "abort_multipart_upload", abort)
    monkeypatch.setattr(cleanup, "delete_object", lambda k: calls["deleted"].append(k))
    monkeypatch.setattr(cleanup, "delete_prefix", lambda k: calls["deleted"].append(k))
    return calls


def _user(db):
    user = User(email=f"discard-{uuid.uuid4()}@t.local", name="t")
    db.add(user)
    db.flush()
    return user


def _seed(db, statuses=(ProcessingStatus.uploading,), role=ProjectRole.editor):
    """An owner with `role` on a project, and an asset whose versions have
    `statuses`, oldest first. Returns (owner, project, asset, versions)."""
    owner = _user(db)
    project = Project(name="t", project_type=ProjectType.personal, created_by=owner.id)
    db.add(project)
    db.flush()
    if role is not None:
        db.add(ProjectMember(project_id=project.id, user_id=owner.id, role=role))
    asset = Asset(project_id=project.id, name="t", asset_type=AssetType.video,
                  created_by=owner.id)
    db.add(asset)
    db.flush()
    versions = []
    for number, status in enumerate(statuses, start=1):
        version = AssetVersion(asset_id=asset.id, version_number=number,
                               processing_status=status, created_by=owner.id,
                               upload_id=f"u-{number}")
        db.add(version)
        db.flush()
        db.add(MediaFile(version_id=version.id, file_type=FileType.video,
                         original_filename="clip.mp4", mime_type="video/mp4",
                         file_size_bytes=23 * MB, s3_key_raw=_key(version)))
        versions.append(version)
    db.commit()
    return owner, project, asset, versions


def _key(version):
    return f"raw/p/a/{version.id}/original.mp4"


def _abort(db, user, version, discard=True):
    body = AbortUploadRequest(s3_key=_key(version), upload_id=version.upload_id,
                              version_id=version.id, discard=discard)
    return upload_module.abort_upload(body, BackgroundTasks(), db=db, current_user=user)


def _committed(db, model, row_id):
    """The row as it stands once everything uncommitted is thrown away."""
    db.rollback()
    db.expire_all()
    return db.get(model, row_id)


# ─── What a discard leaves behind ────────────────────────────────────────────

def test_discarding_the_only_version_removes_the_asset_and_commits_it(db, storage):
    owner, _, asset, (version,) = _seed(db)

    _abort(db, owner, version)

    assert _committed(db, AssetVersion, version.id).deleted_at is not None
    # The asset goes with its only version, or it comes back as a card that
    # cannot be opened.
    assert _committed(db, Asset, asset.id).deleted_at is not None
    assert _key(version) in storage["deleted"]


def test_a_discard_is_not_recorded_as_a_failure(db, storage):
    owner, _, _, (version,) = _seed(db)

    _abort(db, owner, version)

    assert _committed(db, AssetVersion, version.id).processing_status == ProcessingStatus.uploading


def test_an_asset_with_another_live_version_stays(db, storage):
    owner, _, asset, (_, second) = _seed(
        db, statuses=(ProcessingStatus.ready, ProcessingStatus.uploading)
    )

    _abort(db, owner, second)

    assert _committed(db, AssetVersion, second.id).deleted_at is not None
    assert _committed(db, Asset, asset.id).deleted_at is None


def test_a_discarded_upload_is_never_published(db, storage, monkeypatch):
    """Even when the object is already whole.

    The plain abort path asks storage whether the object assembled and promotes
    the version if it did. A discard must not reach that question at all.
    """
    owner, _, _, (version,) = _seed(db)
    dispatched = []
    monkeypatch.setattr(upload_module, "head_object_size", lambda k: 23 * MB)
    monkeypatch.setattr(upload_module, "_trigger_processing",
                        lambda a, v: dispatched.append(v))

    _abort(db, owner, version)

    assert dispatched == []
    assert _committed(db, AssetVersion, version.id).processing_status != ProcessingStatus.processing


# ─── What a discard must not touch ───────────────────────────────────────────

def test_the_flag_cannot_delete_a_version_that_already_landed(db, storage):
    """Otherwise it is a version-delete endpoint by the back door."""
    owner, _, asset, (version,) = _seed(db, statuses=(ProcessingStatus.ready,))

    _abort(db, owner, version)

    stored = _committed(db, AssetVersion, version.id)
    assert stored.deleted_at is None
    assert stored.processing_status == ProcessingStatus.ready
    assert storage["deleted"] == []


def test_a_completion_that_lands_during_the_abort_is_not_thrown_away(db, storage, monkeypatch):
    """The status is re-read after the storage round trip, not trusted from before it.

    `/upload/complete` can commit `processing` while this request is waiting on
    storage to abort. The version object in hand still says `uploading`, and a
    discard deciding on that deletes the master of a version whose transcode has
    just been dispatched. The update below goes straight to the connection,
    past the session, which is what another transaction's commit looks like
    from inside this one.
    """
    owner, _, asset, (version,) = _seed(db)

    def complete_lands_meanwhile(key, upload_id):
        storage["aborted"].append((key, upload_id))
        db.connection().execute(
            text("UPDATE asset_versions SET processing_status = 'processing' WHERE id = :id"),
            {"id": version.id},
        )
    monkeypatch.setattr(upload_module, "abort_multipart_upload", complete_lands_meanwhile)

    _abort(db, owner, version)

    # Status is not asserted after the rollback: the simulated commit shares
    # this connection, so the rollback takes it back too.
    assert _committed(db, AssetVersion, version.id).deleted_at is None
    assert _key(version) not in storage["deleted"]
    assert _committed(db, Asset, asset.id).deleted_at is None


def test_without_the_flag_a_transfer_that_gave_up_is_still_failed(db, storage, monkeypatch):
    owner, _, _, (version,) = _seed(db)
    monkeypatch.setattr(upload_module, "head_object_size", lambda k: 0)

    _abort(db, owner, version, discard=False)

    stored = _committed(db, AssetVersion, version.id)
    assert stored.processing_status == ProcessingStatus.failed
    assert stored.deleted_at is None


# ─── Who may discard what ────────────────────────────────────────────────────

def test_another_users_upload_cannot_be_discarded(db, storage):
    owner, _, asset, (version,) = _seed(db)
    stranger = _user(db)
    db.commit()

    with pytest.raises(HTTPException) as refused:
        _abort(db, stranger, version)

    assert refused.value.status_code == 403
    assert storage == {"aborted": [], "deleted": []}
    assert _committed(db, AssetVersion, version.id).deleted_at is None
    assert _committed(db, Asset, asset.id).deleted_at is None


def test_without_a_role_on_the_project_the_version_goes_but_the_asset_stays(db, storage):
    """`created_by` outlives being removed from the project; the role does not.

    Deleting an asset needs `editor` everywhere else, so a discard does not get
    to remove one on the strength of having started the upload. The version is
    still theirs to throw away, and an asset left with no versions is the
    reaper's to collect.
    """
    owner, _, asset, (version,) = _seed(db, role=ProjectRole.reviewer)

    _abort(db, owner, version)

    assert _committed(db, AssetVersion, version.id).deleted_at is not None
    assert _committed(db, Asset, asset.id).deleted_at is None


# ─── The trash ───────────────────────────────────────────────────────────────

def test_a_discarded_first_upload_is_not_offered_in_the_trash(db, storage):
    """It was never an asset anyone could open, so it is not deleted work.

    Listed, it would pile up beside the things people actually deleted, and
    restoring it would bring back the unopenable card the strip exists to remove.
    """
    owner, project, discarded, (version,) = _seed(db)
    _abort(db, owner, version)

    deleted = Asset(project_id=project.id, name="real", asset_type=AssetType.video,
                    created_by=owner.id)
    db.add(deleted)
    db.flush()
    db.add(AssetVersion(asset_id=deleted.id, version_number=1,
                        processing_status=ProcessingStatus.ready, created_by=owner.id))
    from datetime import datetime, timezone
    deleted.deleted_at = datetime.now(timezone.utc)
    db.commit()

    listed = folders_module.list_trash(project.id, skip=0, limit=50, db=db, current_user=owner)

    ids = {a["id"] for a in listed["assets"]}
    assert str(deleted.id) in ids
    assert str(discarded.id) not in ids

    with pytest.raises(HTTPException) as refused:
        folders_module.restore_asset(discarded.id, db=db, current_user=owner)
    assert refused.value.status_code == 404


def test_a_deleted_asset_whose_transcode_failed_is_still_in_the_trash(db, storage):
    """A failed transcode landed. It is deleted work and has to be restorable.

    `_was_ever_usable` is named and documented for "ever got as far as
    `processing`", and it exists to hide an upload that was discarded or
    reclaimed before it landed. A version that finished uploading, dispatched a
    transcode and then failed is not that: it is a real asset carrying a red
    Failed badge, and someone who deletes it from the grid is deleting something
    they made. Filtering on the CURRENT status rather than on how far it ever
    got took it out of the trash and made restore answer 404.
    """
    from datetime import datetime, timezone

    owner, project, asset, _ = _seed(db, statuses=(ProcessingStatus.failed,))
    asset.deleted_at = datetime.now(timezone.utc)
    db.commit()

    listed = folders_module.list_trash(project.id, skip=0, limit=50, db=db, current_user=owner)

    assert str(asset.id) in {a["id"] for a in listed["assets"]}

    # and it can actually be brought back, which is the point of being listed
    folders_module.restore_asset(asset.id, db=db, current_user=owner)
    db.refresh(asset)
    assert asset.deleted_at is None


def test_an_upload_that_never_landed_is_still_kept_out_of_the_trash(db, storage):
    """The guard the other way: widening the predicate must not undo #312.

    `uploading` is the status the helper actually exists to exclude, and it stays
    excluded. Without this, adding `failed` could be 'fixed' by dropping the
    filter entirely and nothing would notice.
    """
    from datetime import datetime, timezone

    owner, project, asset, _ = _seed(db, statuses=(ProcessingStatus.uploading,))
    asset.deleted_at = datetime.now(timezone.utc)
    db.commit()

    listed = folders_module.list_trash(project.id, skip=0, limit=50, db=db, current_user=owner)

    assert str(asset.id) not in {a["id"] for a in listed["assets"]}
