"""Tests for persisting the S3 upload id and last upload activity on a version.

Both columns exist to be read: `upload_id` so `/upload/presign-part` has something
to check the caller's value against, and `last_activity_at` so the stale-upload
reaper ages an upload by progress rather than by when it started.
"""
import uuid
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock

import pytest

import apps.api.routers.upload as upload_module
from apps.api.models.asset import ProcessingStatus


@pytest.fixture
def presign_rows(mock_db, test_user):
    """A media file and the version that owns it, wired into the mock session."""
    media_file = MagicMock()
    media_file.version_id = uuid.uuid4()
    media_file.s3_key_raw = "raw/p/a/v/original.mp4"

    version = MagicMock()
    version.id = media_file.version_id
    version.created_by = test_user.id
    version.upload_id = "the-real-upload-id"
    version.last_activity_at = None

    mock_db.first.side_effect = [media_file, version]
    return media_file, version


def _presign(client, auth_headers, media_file, upload_id, part=1):
    return client.post(
        "/upload/presign-part",
        json={"s3_key": media_file.s3_key_raw, "upload_id": upload_id, "part_number": part},
        headers=auth_headers,
    )


# ------------------------------------------------------------------ upload_id

def test_presign_signs_the_upload_the_version_belongs_to(
    client, auth_headers, mock_db, presign_rows, monkeypatch
):
    media_file, _ = presign_rows
    signed = {}
    monkeypatch.setattr(
        upload_module, "presign_upload_part",
        lambda k, u, n: signed.update(key=k, upload=u, part=n) or "https://s3/url",
    )

    resp = _presign(client, auth_headers, media_file, "the-real-upload-id")

    assert resp.status_code == 200
    assert signed["upload"] == "the-real-upload-id"


def test_presign_refuses_an_upload_id_the_version_does_not_own(
    client, auth_headers, mock_db, presign_rows, monkeypatch
):
    """Previously any value the caller sent was handed to the signer unchecked."""
    media_file, _ = presign_rows
    monkeypatch.setattr(
        upload_module, "presign_upload_part",
        lambda k, u, n: pytest.fail("must not sign a foreign upload id"),
    )

    resp = _presign(client, auth_headers, media_file, "some-other-upload")

    assert resp.status_code == 403


def test_presign_still_works_for_versions_recorded_before_this_column_existed(
    client, auth_headers, mock_db, presign_rows, monkeypatch
):
    """NULL means "unknown", not "no upload". Uploads in flight across the
    upgrade must not start failing halfway."""
    media_file, version = presign_rows
    version.upload_id = None
    monkeypatch.setattr(upload_module, "presign_upload_part", lambda k, u, n: "https://s3/url")

    assert _presign(client, auth_headers, media_file, "whatever-it-was").status_code == 200


def test_presign_refuses_a_version_the_reaper_already_soft_deleted(real_db, monkeypatch):
    """Real DB, because the filter under test is a query clause.

    A mocked session hands back whatever it was primed with no matter what the
    query said, so this passes with the filter removed unless it runs for real.
    Parts signed for a soft-deleted version are written to a key nothing owns and
    no later sweep attributes to anything.
    """
    from apps.api.models.user import User
    from apps.api.models.project import Project, ProjectType
    from apps.api.models.asset import Asset, AssetType, AssetVersion, MediaFile, FileType
    from apps.api.schemas.upload import PresignPartRequest
    from fastapi import HTTPException

    owner = User(email=f"sd-{uuid.uuid4()}@t.local", name="t")
    real_db.add(owner); real_db.flush()
    project = Project(name="t", project_type=ProjectType.personal, created_by=owner.id)
    real_db.add(project); real_db.flush()
    asset = Asset(project_id=project.id, name="t", asset_type=AssetType.video, created_by=owner.id)
    real_db.add(asset); real_db.flush()
    version = AssetVersion(asset_id=asset.id, version_number=1,
                           processing_status=ProcessingStatus.uploading, created_by=owner.id,
                           upload_id="u-1", deleted_at=datetime.now(timezone.utc))
    real_db.add(version); real_db.flush()
    key = f"raw/{version.id}/original.mp4"
    real_db.add(MediaFile(version_id=version.id, file_type=FileType.video,
                          original_filename="f.mp4", mime_type="video/mp4",
                          file_size_bytes=1, s3_key_raw=key))
    real_db.flush()

    monkeypatch.setattr(upload_module, "presign_upload_part",
                        lambda k, u, n: pytest.fail("must not sign for a deleted version"))

    with pytest.raises(HTTPException) as exc:
        upload_module.presign_part(
            PresignPartRequest(s3_key=key, upload_id="u-1", part_number=1),
            db=real_db, current_user=owner,
        )
    assert exc.value.status_code == 403


# ------------------------------------------------------------ last_activity_at

def test_presign_records_activity_so_a_slow_upload_is_not_reaped(
    client, auth_headers, mock_db, presign_rows, monkeypatch
):
    media_file, version = presign_rows
    monkeypatch.setattr(upload_module, "presign_upload_part", lambda k, u, n: "https://s3/url")
    before = datetime.now(timezone.utc)

    _presign(client, auth_headers, media_file, "the-real-upload-id")

    assert version.last_activity_at is not None
    assert version.last_activity_at >= before


# ------------------------------------------------------------------ initiate

@pytest.mark.parametrize("path", ["new_asset", "new_version"])
def test_both_initiate_paths_record_the_upload_id(real_db, monkeypatch, path):
    """There are two initiate handlers and they are near-verbatim copies.

    Recording the upload id in only one of them would leave every new *version*
    unresumable and unvalidatable, which is the half nobody would notice.
    """
    from apps.api.models.user import User
    from apps.api.models.project import Project, ProjectType
    from apps.api.models.asset import Asset, AssetType, AssetVersion
    from apps.api.schemas.upload import InitiateUploadRequest
    import apps.api.routers.assets as assets_module

    owner = User(email=f"init-{uuid.uuid4()}@t.local", name="t")
    real_db.add(owner); real_db.flush()
    project = Project(name="t", project_type=ProjectType.personal, created_by=owner.id)
    real_db.add(project); real_db.flush()

    for mod in (upload_module, assets_module):
        monkeypatch.setattr(mod, "create_multipart_upload", lambda k, m: "brand-new-upload",
                            raising=False)
    monkeypatch.setattr(upload_module, "upload_guard_error", lambda db, n: None)
    monkeypatch.setattr(assets_module, "upload_guard_error", lambda db, n: None, raising=False)
    monkeypatch.setattr(upload_module, "require_project_role", lambda db, pid, u, r: None)

    if path == "new_asset":
        body = InitiateUploadRequest(
            project_id=project.id, asset_name="clip", original_filename="clip.mp4",
            mime_type="video/mp4", file_size_bytes=1024,
        )
        result = upload_module.initiate_upload(body, db=real_db, current_user=owner)
    else:
        asset = Asset(project_id=project.id, name="t", asset_type=AssetType.video,
                      created_by=owner.id)
        real_db.add(asset); real_db.flush()
        monkeypatch.setattr(assets_module, "require_project_role", lambda *a, **k: None,
                            raising=False)
        result = assets_module.initiate_new_version(
            asset.id,
            InitiateUploadRequest(
                project_id=project.id, asset_name="clip", original_filename="clip.mp4",
                mime_type="video/mp4", file_size_bytes=1024,
            ),
            db=real_db, current_user=owner,
        )

    version = real_db.query(AssetVersion).filter(AssetVersion.id == result.version_id).first()
    assert version.upload_id == "brand-new-upload"
    assert version.last_activity_at is not None


# -------------------------------------------------------------------- reaper

def _seed_version(db, status, created_shift_hours, activity_shift_hours=None):
    from apps.api.models.user import User
    from apps.api.models.project import Project, ProjectType
    from apps.api.models.asset import Asset, AssetType, AssetVersion, MediaFile, FileType

    owner = User(email=f"act-{uuid.uuid4()}@t.local", name="t")
    db.add(owner); db.flush()
    project = Project(name="t", project_type=ProjectType.personal, created_by=owner.id)
    db.add(project); db.flush()
    asset = Asset(project_id=project.id, name="t", asset_type=AssetType.video, created_by=owner.id)
    db.add(asset); db.flush()
    v = AssetVersion(asset_id=asset.id, version_number=1, processing_status=status,
                     created_by=owner.id)
    db.add(v); db.flush()
    v.created_at = datetime.now(timezone.utc) - timedelta(hours=created_shift_hours)
    if activity_shift_hours is not None:
        v.last_activity_at = datetime.now(timezone.utc) - timedelta(hours=activity_shift_hours)
    db.add(MediaFile(version_id=v.id, file_type=FileType.video, original_filename="f.mp4",
                     mime_type="video/mp4", file_size_bytes=1, s3_key_raw=f"raw/{v.id}"))
    db.flush()
    return v


def test_reaper_spares_a_slow_upload_that_is_still_making_progress(real_db, monkeypatch):
    """A 90 GB upload on a slow line outlives a 24h window while still progressing.

    Ageing it by when it *started* destroys an upload that is working fine, which is
    the case this column exists for.
    """
    from apps.api.tasks import cleanup_tasks as ct

    monkeypatch.setattr(ct, "list_stale_multipart_uploads", lambda cutoff: [])
    monkeypatch.setattr(ct, "delete_object", lambda k: None)
    monkeypatch.setattr(ct, "delete_prefix", lambda k: None)

    # Started two days ago, signed a part a minute ago: still going.
    slow_but_alive = _seed_version(real_db, ProcessingStatus.uploading, 48, activity_shift_hours=0)
    # Started two days ago and silent since: genuinely abandoned.
    abandoned = _seed_version(real_db, ProcessingStatus.uploading, 48, activity_shift_hours=48)
    # Predates the column entirely; must still be reaped via created_at.
    legacy = _seed_version(real_db, ProcessingStatus.uploading, 48)

    ct._reap_stale_uploads(real_db)

    assert slow_but_alive.deleted_at is None
    assert abandoned.deleted_at is not None
    assert legacy.deleted_at is not None
