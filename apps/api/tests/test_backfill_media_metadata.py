"""Backfill task (#124): probes raw files and fills missing metadata."""
import json
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
