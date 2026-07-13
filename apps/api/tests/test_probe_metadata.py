"""parse_probe_metadata (#124): fps fraction handling, 0/0 guard, duration fallback."""
from packages.transcoder.ffmpeg_transcoder import parse_probe_metadata


def test_fractional_ntsc_rate():
    meta = parse_probe_metadata({
        "streams": [{"r_frame_rate": "30000/1001", "width": 1920, "height": 1080, "duration": "10.5"}],
        "format": {"duration": "10.5"},
    })
    assert abs(meta.fps - 29.97002997) < 1e-6
    assert meta.width == 1920 and meta.height == 1080
    assert meta.duration_seconds == 10.5


def test_zero_denominator_rate_is_guarded():
    meta = parse_probe_metadata({"streams": [{"r_frame_rate": "0/0", "width": 640, "height": 480}]})
    assert meta.fps == 0.0


def test_missing_stream_duration_falls_back_to_format():
    meta = parse_probe_metadata({
        "streams": [{"r_frame_rate": "25/1", "width": 1280, "height": 720}],
        "format": {"duration": "42.25"},
    })
    assert meta.duration_seconds == 42.25


def test_no_video_stream_returns_none():
    assert parse_probe_metadata({"streams": [], "format": {"duration": "5"}}) is None


def test_missing_rate_yields_zero_fps_not_fabricated_30():
    meta = parse_probe_metadata({"streams": [{"width": 10, "height": 10, "duration": "1"}]})
    assert meta.fps == 0.0
