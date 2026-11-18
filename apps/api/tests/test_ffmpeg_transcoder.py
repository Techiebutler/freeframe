"""
Tests for FFmpegTranscoder: command construction and error handling.

Verifies:
- has_audio=True  → ffmpeg cmd includes -map a:0, var_stream_map has audio tracks
- has_audio=False → ffmpeg cmd excludes -map a:0, var_stream_map is video-only
- _run() uses errors='replace' to survive Latin-1/Shift-JIS metadata
- _run() raises RuntimeError with stderr on non-zero exit
"""
import asyncio
import io
from collections import deque
import json
from unittest.mock import MagicMock, patch

import pytest

from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder, validate_hls_output as _validate_hls_output
from packages.transcoder.base import TranscodeJob


class _FakeProc:
    """Stands in for the ffmpeg process behind subprocess.Popen.

    The main encode moved from subprocess.run to Popen when progress streaming
    was added, so it needs a line-iterable stdout that can be closed. Both
    ffprobe calls and the thumbnail pass still go through subprocess.run.
    """

    def __init__(self, lines=(), returncode=0):
        self.stdout = io.StringIO(chr(10).join(lines))
        self._returncode = returncode

    def wait(self):
        return self._returncode

    def kill(self):
        pass


_popen_holder = {}


@pytest.fixture(autouse=True)
def _patch_popen():
    """Every transcode test drives the main encode, which now uses Popen."""
    with patch("subprocess.Popen") as mock_popen:
        mock_popen.side_effect = lambda *a, **k: _FakeProc(
            ["out_time=00:00:03.000000", "progress=continue", "progress=end"]
        )
        _popen_holder["mock"] = mock_popen
        yield mock_popen
        _popen_holder.pop("mock", None)


@pytest.fixture(autouse=True)
def _bypass_hls_validation_for_command_tests():
    """Command tests do not create ffmpeg's real playlist files.

    Dedicated tests below exercise the validator against real temporary files;
    this keeps the existing command-construction tests focused on their concern.
    """
    with patch("packages.transcoder.ffmpeg_transcoder.validate_hls_output"):
        yield


def _make_job(qualities: list[str] | None = None) -> TranscodeJob:
    return TranscodeJob(
        media_id="media-1",
        version_id="v1",
        input_s3_key="uploads/video.mp4",
        output_s3_prefix="hls/media-1/v1",
        qualities=qualities or ["1080p", "720p", "360p"],
    )
def _mock_probe_side_effect(width: int, height: int):
    """Build a subprocess.run side_effect returning a fixed video probe
    (given width/height) and no audio stream, then a generic success
    result for the main ffmpeg transcode call."""
    def mock_run_side_effect(cmd, **_kwargs):
        if "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "v:0":
            mock = MagicMock()
            mock.returncode = 0
            mock.stderr = ""
            mock.stdout = json.dumps({
                "streams": [{"r_frame_rate": "30/1", "duration": 6.0, "width": width, "height": height}],
            })
            return mock
        if "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "a":
            mock = MagicMock()
            mock.returncode = 0
            mock.stderr = ""
            mock.stdout = json.dumps({"streams": []})
            return mock
        mock = MagicMock()
        mock.returncode = 0
        mock.stderr = ""
        return mock
    return mock_run_side_effect


def _get_ffmpeg_cmd():
    """Pull the main ffmpeg transcode command (the one with -filter_complex)
    out of the mocked subprocess.Popen call list."""
    mock_popen = _popen_holder["mock"]
    ffmpeg_calls = [c for c in mock_popen.call_args_list
                    if any("filter_complex" in str(a) for a in c[0][0])]
    assert len(ffmpeg_calls) > 0, "no -filter_complex call was made"
    return ffmpeg_calls[0][0][0]

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


# ─── HLS output validation ───────────────────────────────────────────────────

def _write_playlist(path, durations, endlist=True):
    path.parent.mkdir(parents=True)
    lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-PLAYLIST-TYPE:VOD"]
    for index, duration in enumerate(durations):
        lines.extend([f"#EXTINF:{duration:.6f},", f"seg_{index:03d}.ts"])
    if endlist:
        lines.append("#EXT-X-ENDLIST")
    path.write_text("\n".join(lines), encoding="utf-8")


def test_validate_hls_output_accepts_complete_duration(tmp_path):
    _write_playlist(tmp_path / "0" / "playlist.m3u8", [2.0, 2.0, 1.5])

    durations = _validate_hls_output(tmp_path, expected_duration_seconds=5.5)

    assert durations == {"0/playlist.m3u8": 5.5}


def test_validate_hls_output_rejects_playlist_without_endlist(tmp_path):
    _write_playlist(tmp_path / "0" / "playlist.m3u8", [2.0], endlist=False)

    with pytest.raises(RuntimeError, match="missing ENDLIST"):
        _validate_hls_output(tmp_path, expected_duration_seconds=2.0)


def test_validate_hls_output_rejects_truncated_playlist(tmp_path):
    _write_playlist(tmp_path / "0" / "playlist.m3u8", [2.0] * 10 + [0.233333])

    with pytest.raises(RuntimeError, match="does not match source duration"):
        _validate_hls_output(tmp_path, expected_duration_seconds=1340.533333)


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

        ffmpeg_cmd = _get_ffmpeg_cmd()

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

        ffmpeg_cmd = _get_ffmpeg_cmd()

        # Assert audio map is NOT present
        maps = [ffmpeg_cmd[i+1] for i, arg in enumerate(ffmpeg_cmd) if arg == "-map"]
        assert "a:0" not in maps, f"Expected no -map a:0 in no-audio transcode, got maps: {maps}"

        # Assert var_stream_map is video-only
        var_stream_idx = ffmpeg_cmd.index("-var_stream_map")
        stream_map = ffmpeg_cmd[var_stream_idx + 1]
        assert ",a:" not in stream_map, f"Expected no audio tracks in var_stream_map, got: {stream_map}"


def test_source_smaller_than_ladder_drops_upscaled_renditions():
    """640x360 source requesting the full ladder must produce only the
    360p rendition — mirrors the exact v1.7.0 smoke-test repro."""
    with patch("subprocess.run", side_effect=_mock_probe_side_effect(640, 360)) as mock_run:
        s3_mock = MagicMock()
        s3_mock.generate_presigned_url.return_value = "https://s3.example.com/uploads/video.mp4"
        s3_mock.upload_file = MagicMock()

        with patch("builtins.open", MagicMock()), \
             patch("pathlib.Path.glob", return_value=[]), \
             patch("pathlib.Path.rglob", return_value=[]), \
             patch("pathlib.Path.mkdir"), \
             patch("shutil.rmtree"):
                transcoder = FFmpegTranscoder(s3_mock, "test-bucket")
                job = _make_job(["1080p", "720p", "360p"])
                result = asyncio.run(transcoder.transcode(job))

        assert result.success is True
        ffmpeg_cmd = _get_ffmpeg_cmd()

        filter_complex = ffmpeg_cmd[ffmpeg_cmd.index("-filter_complex") + 1]
        assert "1920:1080" not in filter_complex, "1080p rendition should have been dropped"
        assert "1280:720" not in filter_complex, "720p rendition should have been dropped"
        assert "640:360" in filter_complex, "360p rendition should still be present"

        # split=1 → exactly one rendition survived
        assert "split=1" in filter_complex

        var_stream_idx = ffmpeg_cmd.index("-var_stream_map")
        stream_map = ffmpeg_cmd[var_stream_idx + 1]
        assert stream_map.strip() == "v:0", f"expected a single video-only stream, got: {stream_map}"


def test_source_smaller_than_all_requested_keeps_smallest():
    """A source below every requested quality must still yield exactly one
    rendition (the smallest requested), never zero."""
    with patch("subprocess.run", side_effect=_mock_probe_side_effect(426, 240)) as mock_run:
        s3_mock = MagicMock()
        s3_mock.generate_presigned_url.return_value = "https://s3.example.com/uploads/video.mp4"
        s3_mock.upload_file = MagicMock()

        with patch("builtins.open", MagicMock()), \
             patch("pathlib.Path.glob", return_value=[]), \
             patch("pathlib.Path.rglob", return_value=[]), \
             patch("pathlib.Path.mkdir"), \
             patch("shutil.rmtree"):
                transcoder = FFmpegTranscoder(s3_mock, "test-bucket")
                job = _make_job(["1080p", "720p"])  # note: no 360p requested
                result = asyncio.run(transcoder.transcode(job))

        assert result.success is True
        ffmpeg_cmd = _get_ffmpeg_cmd()
        filter_complex = ffmpeg_cmd[ffmpeg_cmd.index("-filter_complex") + 1]

        assert "1920:1080" not in filter_complex
        assert "1280:720" in filter_complex, "smallest requested quality (720p) must survive as fallback"
        assert "split=1" in filter_complex


def test_source_larger_than_ladder_keeps_full_ladder():
    """Regression check: a source at/above the top rendition must still
    produce the full requested ladder, unchanged from before the fix."""
    with patch("subprocess.run", side_effect=_mock_probe_side_effect(1920, 1080)) as mock_run:
        s3_mock = MagicMock()
        s3_mock.generate_presigned_url.return_value = "https://s3.example.com/uploads/video.mp4"
        s3_mock.upload_file = MagicMock()

        with patch("builtins.open", MagicMock()), \
             patch("pathlib.Path.glob", return_value=[]), \
             patch("pathlib.Path.rglob", return_value=[]), \
             patch("pathlib.Path.mkdir"), \
             patch("shutil.rmtree"):
                transcoder = FFmpegTranscoder(s3_mock, "test-bucket")
                job = _make_job(["1080p", "720p", "360p"])
                result = asyncio.run(transcoder.transcode(job))

        assert result.success is True
        ffmpeg_cmd = _get_ffmpeg_cmd()
        filter_complex = ffmpeg_cmd[ffmpeg_cmd.index("-filter_complex") + 1]

        assert "1920:1080" in filter_complex
        assert "1280:720" in filter_complex
        assert "640:360" in filter_complex
        assert "split=3" in filter_complex


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


def test_successful_ffmpeg_tail_is_sanitized_for_later_validation_diagnostics(monkeypatch):
    from packages.transcoder.ffmpeg_transcoder import _safe_diagnostic_tail

    diagnostic = _safe_diagnostic_tail(deque([
        "frame=100",
        "Input #0, mov, from 'https://storage.example/video?X-Amz-Signature=secret'",
        "out_time=00:00:22.250000",
    ]))

    assert "secret" not in diagnostic
    assert "<redacted-url>" in diagnostic


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
         patch.object(FFmpegTranscoder, "_run_with_progress"), \
         patch.object(FFmpegTranscoder, "_get_presigned_url", return_value="http://in"):
        result = asyncio.run(t.transcode(_make_job()))

    assert result.success is True
    assert result.fps == 25.0
    assert result.width == 1920
    assert result.duration_seconds == 8.0


def test_transcode_reports_an_audio_only_video_container_before_encoding():
    transcoder = FFmpegTranscoder(MagicMock(), "bucket")
    audio_only_probe = json.dumps({"streams": [], "format": {"duration": "3.0"}})

    with patch.object(FFmpegTranscoder, "_run", return_value=audio_only_probe) as run, \
         patch.object(FFmpegTranscoder, "_run_with_progress") as transcode, \
         patch.object(FFmpegTranscoder, "_get_presigned_url", return_value="http://in"):
        result = asyncio.run(transcoder.transcode(_make_job()))

    assert result.success is False
    assert result.no_video_stream is True
    assert "No video stream" in (result.error or "")
    assert run.call_count == 1
    transcode.assert_not_called()


def test_no_video_stream_defaults_to_false_for_other_transcoder_backends():
    from packages.transcoder.base import TranscodeResult

    assert TranscodeResult(success=True).no_video_stream is False
    assert TranscodeResult(success=False, error="boom").no_video_stream is False


# ─── keyframe interval (scrub smoothness) ─────────────────────────────────────

from packages.transcoder.ffmpeg_transcoder import resolve_keyframe_interval  # noqa: E402


@pytest.mark.parametrize(
    "raw, expected",
    [
        (None, 1.0),        # default: 1s keyframes
        ("", 1.0),
        ("0.5", 0.5),
        ("2", 2.0),
        ("10", 2.0),        # capped: segments are 2s and must start on a keyframe
        ("0.01", 0.25),     # floored: avoid all-intra bloat from a typo
        ("fast", 1.0),      # unparsable → default instead of failing encodes
        ("nan", 1.0),
    ],
)
def test_resolve_keyframe_interval(monkeypatch, raw, expected):
    if raw is None:
        monkeypatch.delenv("HLS_KEYFRAME_INTERVAL", raising=False)
    else:
        monkeypatch.setenv("HLS_KEYFRAME_INTERVAL", raw)
    assert resolve_keyframe_interval() == expected


def _encode_cmd_with_interval(monkeypatch, raw):
    if raw is None:
        monkeypatch.delenv("HLS_KEYFRAME_INTERVAL", raising=False)
    else:
        monkeypatch.setenv("HLS_KEYFRAME_INTERVAL", raw)
    with patch("subprocess.run", side_effect=_mock_probe_side_effect(1920, 1080)):
        s3_mock = MagicMock()
        s3_mock.generate_presigned_url.return_value = "https://s3.example.com/uploads/video.mp4"
        with patch("builtins.open", MagicMock()), \
             patch("pathlib.Path.glob", return_value=[]), \
             patch("pathlib.Path.rglob", return_value=[]), \
             patch("pathlib.Path.mkdir"), \
             patch("shutil.rmtree"):
            transcoder = FFmpegTranscoder(s3_mock, "test-bucket")
            assert asyncio.run(transcoder.transcode(_make_job(["720p", "360p"]))).success
    return _get_ffmpeg_cmd()


def test_every_rendition_forces_keyframes_every_second_by_default(monkeypatch):
    """Scrubbing uses fastSeek (nearest keyframe): 1s keyframes, as IDR frames."""
    cmd = _encode_cmd_with_interval(monkeypatch, None)
    forced = [cmd[i + 1] for i, arg in enumerate(cmd) if arg == "-force_key_frames"]
    assert forced == ["expr:gte(t,n_forced*1)"] * 2
    idr = [cmd[i + 1] for i, arg in enumerate(cmd) if arg == "-forced-idr"]
    assert idr == ["1"] * 2
    # Segment length is unchanged, so a segment always holds whole GOPs.
    assert cmd[cmd.index("-hls_time") + 1] == "2"


def test_keyframe_interval_is_configurable(monkeypatch):
    cmd = _encode_cmd_with_interval(monkeypatch, "0.5")
    assert "expr:gte(t,n_forced*0.5)" in cmd
