"""An audio-only file in a video container must upload successfully (#82).

The browser types a .mpg or .mp4 carrying only an audio track as video/*, so
`mime_to_asset_type` routes it to the video pipeline. The file is fine; it just
is not video. It should end up as an audio asset rather than a failed upload.
"""
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from apps.api.models.asset import AssetType
from apps.api.tasks import transcode_tasks
from packages.transcoder.base import TranscodeResult


from contextlib import contextmanager


@contextmanager
def _stub_transcoder(result: TranscodeResult):
    """Stub the transcoder and the async bridge together.

    Patching only _run_async leaves the real transcode() coroutine constructed
    and never awaited, which surfaces as a RuntimeWarning.
    """
    with patch("packages.transcoder.ffmpeg_transcoder.FFmpegTranscoder") as cls, \
         patch.object(transcode_tasks, "_run_async", MagicMock(return_value=result)):
        cls.return_value.transcode.return_value = None
        yield


def _fixtures():
    asset = SimpleNamespace(id="asset-1", project_id="proj-1", asset_type=AssetType.video)
    version = SimpleNamespace(id="ver-1")
    media_file = SimpleNamespace(
        s3_key_raw="raw/clip.mpg", s3_key_processed=None,
        s3_key_thumbnail=None, duration_seconds=None,
    )
    return asset, version, media_file, MagicMock()


def test_a_video_container_with_no_video_track_becomes_an_audio_asset():
    asset, version, media_file, db = _fixtures()

    with _stub_transcoder(TranscodeResult(success=False, no_video_stream=True,
                                          error="No video stream in raw/clip.mpg")), \
         patch.object(transcode_tasks, "_process_audio") as audio:
        transcode_tasks._process_video(db, asset, version, media_file, MagicMock(), "processed/x")

    # re-typed, so the viewer renders it with the audio player and the waveform
    assert asset.asset_type == AssetType.audio
    # and actually processed, rather than left half-done
    audio.assert_called_once()
    assert audio.call_args[0][0] is db
    assert audio.call_args[0][3] is media_file


def test_a_genuine_transcode_failure_still_raises():
    """no_video_stream must not become a catch-all that swallows real errors."""
    asset, version, media_file, db = _fixtures()

    with _stub_transcoder(TranscodeResult(success=False, error="ffmpeg exited 1")), \
         patch.object(transcode_tasks, "_process_audio") as audio:
        try:
            transcode_tasks._process_video(db, asset, version, media_file, MagicMock(), "processed/x")
        except RuntimeError as exc:
            assert "ffmpeg exited 1" in str(exc)
        else:
            raise AssertionError("a failed transcode must raise")

    assert asset.asset_type == AssetType.video   # untouched
    audio.assert_not_called()
