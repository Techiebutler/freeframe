"""Format serializers for comment export (#84): EDL, FCPXML, xmeml."""
from xml.etree import ElementTree as ET

from apps.api.services.comment_export import (
    Marker, snap_fps, tc_to_frames, to_edl, to_fcpxml,
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


def _fcpxml_root(xml: str):
    assert xml.startswith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n')
    return ET.fromstring(xml.split("<!DOCTYPE fcpxml>\n", 1)[1])


def test_fcpxml_structure_and_rational_times():
    xml = to_fcpxml([_marker()], SPEC25, "Demo", total_duration_frames=1500)
    root = _fcpxml_root(xml)
    assert root.tag == "fcpxml" and root.get("version") == "1.9"
    fmt = root.find("./resources/format")
    assert fmt.get("frameDuration") == "1/25s"
    gap = root.find("./library/event/project/sequence/spine/gap")
    assert gap.get("duration") == "1500/25s"
    marker = gap.find("marker")
    assert marker.get("start") == "63/25s"
    assert marker.get("duration") == "1/25s"
    assert marker.get("value") == "Jane: Fix the logo"
    assert marker.get("completed") is None


def test_fcpxml_ntsc_frame_duration_and_completed():
    df = snap_fps(29.97)
    xml = to_fcpxml([_marker(frames=100, resolved=True, note="— Bob: ok")], df, "D", 0)
    root = _fcpxml_root(xml)
    assert root.find("./resources/format").get("frameDuration") == "1001/30000s"
    marker = root.find(".//marker")
    assert marker.get("start") == "100100/30000s"
    assert marker.get("completed") == "1"
    assert marker.get("note") == "— Bob: ok"


def test_fcpxml_gap_extends_past_last_marker_when_duration_unknown():
    xml = to_fcpxml([_marker(frames=1000)], SPEC25, "D", total_duration_frames=0)
    gap = _fcpxml_root(xml).find(".//gap")
    assert gap.get("duration") == f"{1000 + 1 + 250}/25s"


from apps.api.services.comment_export import to_premiere_xml


def _xmeml_seq(xml: str):
    assert xml.startswith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n')
    return ET.fromstring(xml.split("<!DOCTYPE xmeml>\n", 1)[1]).find("sequence")


def test_xmeml_point_marker_and_rate():
    seq = _xmeml_seq(to_premiere_xml([_marker()], SPEC25, "Demo", 1500))
    assert seq.find("rate/timebase").text == "25"
    assert seq.find("rate/ntsc").text == "FALSE"
    marker = seq.find("marker")
    assert marker.find("name").text == "Jane: Fix the logo"
    assert marker.find("in").text == "63"
    assert marker.find("out").text == "-1"


def test_xmeml_ntsc_range_and_resolved_prefix():
    df = snap_fps(29.97)
    seq = _xmeml_seq(to_premiere_xml(
        [_marker(frames=100, duration=30, resolved=True, note="— Bob: ok")], df, "D", 0))
    assert seq.find("rate/timebase").text == "30"
    assert seq.find("rate/ntsc").text == "TRUE"
    marker = seq.find("marker")
    assert marker.find("out").text == "130"
    assert marker.find("comment").text == "[resolved] — Bob: ok"
