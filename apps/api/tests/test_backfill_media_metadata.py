"""Backfill task (#124): probes raw files and fills missing metadata."""
import json
import subprocess
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from apps.api.models.asset import AssetType


def _mock_db(rows):
    db = MagicMock()
    db.query.return_value = db
    db.join.return_value = db
    db.filter.return_value = db
    db.all.return_value = rows
    return db


def _video_probe():
    return json.dumps({
        "streams": [{"r_frame_rate": "30000/1001", "width": 3840, "height": 2160, "duration": "12.0"}],
        "format": {"duration": "12.0"},
    })


def test_backfill_updates_video_row():
    from apps.api.tasks.transcode_tasks import backfill_media_metadata

    media_file = MagicMock(duration_seconds=None, s3_key_raw="raw/key.mp4")
    db = _mock_db([(media_file, AssetType.video)])
    probe = MagicMock(returncode=0, stdout=_video_probe())

    with patch("apps.api.tasks.transcode_tasks.SessionLocal", return_value=db), \
         patch("apps.api.tasks.transcode_tasks.get_s3_client") as s3, \
         patch("subprocess.run", return_value=probe):
        s3.return_value.generate_presigned_url.return_value = "https://example/presigned"
        result = backfill_media_metadata.apply().get()

    assert result == {"updated": 1, "skipped": 0}
    assert media_file.width == 3840
    assert abs(media_file.fps - 29.97002997) < 0.001
    db.commit.assert_called()


def test_backfill_skips_failed_probe():
    from apps.api.tasks.transcode_tasks import backfill_media_metadata

    media_file = MagicMock(duration_seconds=None, s3_key_raw="raw/bad.mp4")
    db = _mock_db([(media_file, AssetType.video)])
    probe = MagicMock(returncode=1, stdout="", stderr="boom")

    with patch("apps.api.tasks.transcode_tasks.SessionLocal", return_value=db), \
         patch("apps.api.tasks.transcode_tasks.get_s3_client") as s3, \
         patch("subprocess.run", return_value=probe):
        s3.return_value.generate_presigned_url.return_value = "https://example/presigned"
        result = backfill_media_metadata.apply().get()

    assert result == {"updated": 0, "skipped": 1}


def test_backfill_audio_uses_format_duration():
    from apps.api.tasks.transcode_tasks import backfill_media_metadata

    media_file = MagicMock(duration_seconds=None, s3_key_raw="raw/a.wav")
    db = _mock_db([(media_file, AssetType.audio)])
    probe = MagicMock(returncode=0, stdout=json.dumps({"format": {"duration": "33.3"}}))

    with patch("apps.api.tasks.transcode_tasks.SessionLocal", return_value=db), \
         patch("apps.api.tasks.transcode_tasks.get_s3_client") as s3, \
         patch("subprocess.run", return_value=probe):
        s3.return_value.generate_presigned_url.return_value = "https://example/presigned"
        result = backfill_media_metadata.apply().get()

    assert result == {"updated": 1, "skipped": 0}
    assert media_file.duration_seconds == 33.3


def test_backfill_skips_row_when_probe_raises_and_continues_batch():
    """Finding 1: an unhandled exception (TimeoutExpired, botocore error, etc.) from presign/probe
    must skip only that row and continue the batch — never abort it."""
    from apps.api.tasks.transcode_tasks import backfill_media_metadata

    bad_file = MagicMock(duration_seconds=None, s3_key_raw="raw/bad.mp4")
    good_file = MagicMock(duration_seconds=None, s3_key_raw="raw/good.mp4")
    db = _mock_db([(bad_file, AssetType.video), (good_file, AssetType.video)])
    good_probe = MagicMock(returncode=0, stdout=_video_probe())

    with patch("apps.api.tasks.transcode_tasks.SessionLocal", return_value=db), \
         patch("apps.api.tasks.transcode_tasks.get_s3_client") as s3, \
         patch("subprocess.run", side_effect=[
             subprocess.TimeoutExpired(cmd="ffprobe", timeout=300),
             good_probe,
         ]):
        s3.return_value.generate_presigned_url.return_value = "https://example/presigned"
        result = backfill_media_metadata.apply().get()

    assert result == {"updated": 1, "skipped": 1}
    assert good_file.width == 3840


def _user(db):
    from apps.api.models.user import User
    u = User(email=f"backfill-{uuid.uuid4()}@t.local", name="t")
    db.add(u); db.flush()
    return u


def _project(db, owner):
    from apps.api.models.project import Project, ProjectType
    p = Project(name="t", project_type=ProjectType.personal, created_by=owner.id)
    db.add(p); db.flush()
    return p


def _asset(db, project, owner, asset_type=AssetType.video):
    from apps.api.models.asset import Asset
    a = Asset(project_id=project.id, name="t", asset_type=asset_type, created_by=owner.id)
    db.add(a); db.flush()
    return a


def _version(db, asset, owner, status, deleted=False):
    from datetime import datetime, timezone
    from apps.api.models.asset import AssetVersion
    v = AssetVersion(asset_id=asset.id, version_number=1, processing_status=status, created_by=owner.id)
    db.add(v); db.flush()
    if deleted:
        v.deleted_at = datetime.now(timezone.utc)
        db.flush()
    return v


def _media(db, version, duration_seconds=None):
    from apps.api.models.asset import MediaFile, FileType
    mf = MediaFile(version_id=version.id, file_type=FileType.video, original_filename="f.mp4",
                   mime_type="video/mp4", file_size_bytes=10, s3_key_raw=f"raw/{version.id}",
                   duration_seconds=duration_seconds)
    db.add(mf); db.flush()
    return mf


def test_eligible_media_rows_scopes_to_ready_nondeleted_null_duration_video_or_audio(real_db):
    """Finding 2: exercise the real query — only the (video|audio, ready, non-deleted,
    duration_seconds IS NULL) row should come back.

    Uses membership assertions (not exact-equality on the full result set) because this
    runs against the shared dev Postgres via `real_db`, which may already contain other
    eligible rows left over from manual testing/other suites — asserting the full result
    set would make this test fragile against that shared state."""
    from apps.api.models.asset import ProcessingStatus
    from apps.api.tasks.transcode_tasks import _eligible_media_rows

    owner = _user(real_db)
    project = _project(real_db, owner)

    # eligible: video asset, ready non-deleted version, duration_seconds NULL
    eligible_asset = _asset(real_db, project, owner, asset_type=AssetType.video)
    eligible_version = _version(real_db, eligible_asset, owner, status=ProcessingStatus.ready)
    eligible_media = _media(real_db, eligible_version, duration_seconds=None)

    # excluded: same shape but duration_seconds already set (idempotency)
    filled_asset = _asset(real_db, project, owner, asset_type=AssetType.video)
    filled_version = _version(real_db, filled_asset, owner, status=ProcessingStatus.ready)
    filled_media = _media(real_db, filled_version, duration_seconds=12.5)

    # excluded: image asset
    image_asset = _asset(real_db, project, owner, asset_type=AssetType.image)
    image_version = _version(real_db, image_asset, owner, status=ProcessingStatus.ready)
    image_media = _media(real_db, image_version, duration_seconds=None)

    # excluded: soft-deleted version
    deleted_version_asset = _asset(real_db, project, owner, asset_type=AssetType.video)
    deleted_version = _version(real_db, deleted_version_asset, owner, status=ProcessingStatus.ready, deleted=True)
    deleted_version_media = _media(real_db, deleted_version, duration_seconds=None)

    # excluded: version not yet ready (still processing)
    processing_asset = _asset(real_db, project, owner, asset_type=AssetType.video)
    processing_version = _version(real_db, processing_asset, owner, status=ProcessingStatus.processing)
    processing_media = _media(real_db, processing_version, duration_seconds=None)

    # excluded: soft-deleted ASSET, version itself still alive (locks fix 2 — asset
    # soft-delete does not cascade to versions, so the query must filter on the asset too)
    deleted_asset = _asset(real_db, project, owner, asset_type=AssetType.video)
    deleted_asset_version = _version(real_db, deleted_asset, owner, status=ProcessingStatus.ready)
    deleted_asset_media = _media(real_db, deleted_asset_version, duration_seconds=None)
    deleted_asset.deleted_at = datetime.now(timezone.utc)
    real_db.flush()

    rows = _eligible_media_rows(real_db)
    result_ids = [mf.id for mf, _asset_type in rows]

    assert eligible_media.id in result_ids
    assert filled_media.id not in result_ids
    assert image_media.id not in result_ids
    assert deleted_version_media.id not in result_ids
    assert processing_media.id not in result_ids
    assert deleted_asset_media.id not in result_ids
