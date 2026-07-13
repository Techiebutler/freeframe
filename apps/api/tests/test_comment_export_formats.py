"""Format serializers for comment export (#84): EDL, FCPXML, xmeml."""
from xml.etree import ElementTree as ET

from apps.api.services.comment_export import (
    Marker, snap_fps, tc_to_frames, to_edl,
)

SPEC25 = snap_fps(25.0)
START = "01:00:00:00"


def _marker(frames=63, duration=1, text="Jane: Fix the logo", note="", resolved=False):
    return Marker(frames=frames, duration_frames=duration, text=text, note=note, resolved=resolved)


def test_edl_golden_25fps():
    edl = to_edl([_marker()], SPEC25, tc_to_frames(START, SPEC25), "Demo Asset")
    assert edl == (
        "TITLE: Demo Asset\n"
        "FCM: NON-DROP FRAME\n"
        "\n"
        "001  001      V     C        01:00:02:13 01:00:02:14 01:00:02:13 01:00:02:14\n"
        " |C:ResolveColorBlue |M:Jane: Fix the logo |D:1\n"
    )


def test_edl_drop_frame_header_and_semicolons():
    df = snap_fps(29.97)
    edl = to_edl([_marker(frames=1800)], df, 0, "T")
    assert "FCM: DROP FRAME" in edl
    assert "00:01:00;02" in edl


def test_edl_sanitizes_pipes_newlines_and_leading_digit():
    edl = to_edl([_marker(text="2nd pass | fix\nthis", note="— Bob: ok")], SPEC25, 0, "T")
    marker_line = [l for l in edl.splitlines() if l.startswith(" |C:")][0]
    assert "|M:_2nd pass / fix this — — Bob: ok " in marker_line
    assert marker_line.count("|") == 3  # only the three field separators


def test_edl_resolved_marker_is_green_and_range_keeps_duration():
    edl = to_edl([_marker(duration=50, resolved=True)], SPEC25, 0, "T")
    assert "|C:ResolveColorGreen" in edl
    assert "|D:50" in edl


def test_edl_caps_at_999_events():
    markers = [_marker(frames=i * 10) for i in range(1200)]
    edl = to_edl(markers, SPEC25, 0, "T")
    assert edl.count("|M:") == 999
