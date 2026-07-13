"""
Tests for FFmpegTranscoder: command construction and error handling.

Verifies:
- has_audio=True  → ffmpeg cmd includes -map a:0, var_stream_map has audio tracks
- has_audio=False → ffmpeg cmd excludes -map a:0, var_stream_map is video-only
- _run() uses errors='replace' to survive Latin-1/Shift-JIS metadata
- _run() raises RuntimeError with stderr on non-zero exit
"""
import asyncio
import json
from unittest.mock import MagicMock, patch

import pytest

from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder
from packages.transcoder.base import TranscodeJob


def _make_job(qualities: list[str] | None = None) -> TranscodeJob:
    return TranscodeJob(
        media_id="media-1",
        version_id="v1",
        input_s3_key="uploads/video.mp4",
        output_s3_prefix="hls/media-1/v1",
        qualities=qualities or ["1080p", "720p", "360p"],
    )


# ─── _run() error handling ────────────────────────────────────────────────────

def test_run_raises_on_nonzero():
    with patch("subprocess.run") as mock_run:
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stderr = "ffmpeg error details"
        mock_run.return_value = mock_result

        with pytest.raises(RuntimeError, match="ffmpeg exited 1: ffmpeg error details"):
            FFmpegTranscoder._run(["ffmpeg", "-i", "test.mp4"], label="ffmpeg")


def test_run_uses_errors_replace():
    """Verify that text=True + errors='replace' is passed to subprocess.run."""
    with patch("subprocess.run") as mock_run:
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stderr = ""
        mock_run.return_value = mock_result

        FFmpegTranscoder._run(["ffmpeg", "-i", "test.mp4"], timeout=60, label="ffmpeg")

        call_kwargs = mock_run.call_args[1]
        assert call_kwargs["text"] is True
        assert call_kwargs["errors"] == "replace"
        assert call_kwargs["timeout"] == 60


# ─── has_audio=True command construction ───────────────────────────────────────

def test_transcode_with_audio_includes_audio_map():
    """When ffprobe detects audio streams, ffmpeg cmd must include -map a:0."""
    def mock_run_side_effect(cmd, **_kwargs):
        # First call: video probe → return metadata
        if "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "v:0":
            mock = MagicMock()
            mock.returncode = 0
            mock.stderr = ""
            mock.stdout = json.dumps({
                "streams": [{"r_frame_rate": "30/1", "duration": 10.0, "width": 1920, "height": 1080}],
            })
            return mock
        # Second call: audio probe → return audio stream
        if "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "a":
            mock = MagicMock()
            mock.returncode = 0
            mock.stderr = ""
            mock.stdout = json.dumps({
                "streams": [{"codec_type": "audio"}],
            })
            return mock
        # Third call: main ffmpeg transcode
        mock = MagicMock()
        mock.returncode = 0
        mock.stderr = ""
        return mock

    with patch("subprocess.run", side_effect=mock_run_side_effect) as mock_run:
        s3_mock = MagicMock()
        s3_mock.generate_presigned_url.return_value = "https://s3.example.com/uploads/video.mp4"
        s3_mock.upload_file = MagicMock()

        # Mock thumbnail generation
        with patch("builtins.open", MagicMock()), \
             patch("pathlib.Path.glob", return_value=[]), \
             patch("pathlib.Path.rglob", return_value=[]), \
             patch("pathlib.Path.mkdir"), \
             patch("shutil.rmtree"):
                transcoder = FFmpegTranscoder(s3_mock, "test-bucket")
                job = _make_job(["720p"])
                asyncio.run(transcoder.transcode(job))

        # Find the main ffmpeg command call (the one with -filter_complex)
        ffmpeg_calls = [c for c in mock_run.call_args_list
                        if any("filter_complex" in str(a) for a in c[0][0])]
        assert len(ffmpeg_calls) > 0
        ffmpeg_cmd = ffmpeg_calls[0][0][0]

        # Assert audio map is present
        assert "-map" in ffmpeg_cmd
        # Find all -map args
        maps = [ffmpeg_cmd[i+1] for i, arg in enumerate(ffmpeg_cmd) if arg == "-map"]
        assert "a:0" in maps, f"Expected -map a:0 in ffmpeg cmd, got maps: {maps}"

        # Assert var_stream_map includes audio tracks
        var_stream_idx = ffmpeg_cmd.index("-var_stream_map")
        stream_map = ffmpeg_cmd[var_stream_idx + 1]
        assert "a:0" in stream_map, f"Expected audio track in var_stream_map, got: {stream_map}"


# ─── has_audio=False command construction ─────────────────────────────────────

def test_transcode_without_audio_excludes_audio_map():
    """When ffprobe detects no audio streams, ffmpeg cmd must NOT include -map a:0."""
    def mock_run_side_effect(cmd, **_kwargs):
        # First call: video probe
        if "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "v:0":
            mock = MagicMock()
            mock.returncode = 0
            mock.stderr = ""
            mock.stdout = json.dumps({
                "streams": [{"r_frame_rate": "30/1", "duration": 10.0, "width": 1920, "height": 1080}],
            })
            return mock
        # Second call: audio probe → NO audio streams
        if "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "a":
            mock = MagicMock()
            mock.returncode = 0
            mock.stderr = ""
            mock.stdout = json.dumps({"streams": []})
            return mock
        # Third call: main ffmpeg transcode
        mock = MagicMock()
        mock.returncode = 0
        mock.stderr = ""
        return mock

    with patch("subprocess.run", side_effect=mock_run_side_effect) as mock_run:
        s3_mock = MagicMock()
        s3_mock.generate_presigned_url.return_value = "https://s3.example.com/uploads/video.mp4"
        s3_mock.upload_file = MagicMock()

        with patch("builtins.open", MagicMock()), \
             patch("pathlib.Path.glob", return_value=[]), \
             patch("pathlib.Path.rglob", return_value=[]), \
             patch("pathlib.Path.mkdir"), \
             patch("shutil.rmtree"):
                transcoder = FFmpegTranscoder(s3_mock, "test-bucket")
                job = _make_job(["720p"])
                asyncio.run(transcoder.transcode(job))

        # Find the main ffmpeg command call
        ffmpeg_calls = [c for c in mock_run.call_args_list
                        if any("filter_complex" in str(a) for a in c[0][0])]
        assert len(ffmpeg_calls) > 0
        ffmpeg_cmd = ffmpeg_calls[0][0][0]

        # Assert audio map is NOT present
        maps = [ffmpeg_cmd[i+1] for i, arg in enumerate(ffmpeg_cmd) if arg == "-map"]
        assert "a:0" not in maps, f"Expected no -map a:0 in no-audio transcode, got maps: {maps}"

        # Assert var_stream_map is video-only
        var_stream_idx = ffmpeg_cmd.index("-var_stream_map")
        stream_map = ffmpeg_cmd[var_stream_idx + 1]
        assert ",a:" not in stream_map, f"Expected no audio tracks in var_stream_map, got: {stream_map}"


# ─── _run() returns stdout on success ──────────────────────────────────────────

def test_run_returns_stdout():
    with patch("subprocess.run") as mock_run:
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stderr = ""
        mock_result.stdout = "output data"
        mock_run.return_value = mock_result

        result = FFmpegTranscoder._run(["echo", "hello"], label="test")
        assert result == "output data"


def test_transcode_returns_probe_metadata():
    t = FFmpegTranscoder(MagicMock(), "bucket")
    video_probe = json.dumps({
        "streams": [{"r_frame_rate": "25/1", "width": 1920, "height": 1080, "duration": "8.0"}],
        "format": {"duration": "8.0"},
    })
    audio_probe = json.dumps({"streams": []})

    def fake_run(cmd, timeout=None, label="ffmpeg"):
        if label == "ffprobe":
            return video_probe if "v:0" in cmd else audio_probe
        return ""

    with patch.object(FFmpegTranscoder, "_run", side_effect=fake_run), \
         patch.object(FFmpegTranscoder, "_get_presigned_url", return_value="http://in"):
        result = asyncio.run(t.transcode(_make_job()))

    assert result.success is True
    assert result.fps == 25.0
    assert result.width == 1920
    assert result.duration_seconds == 8.0
