"""Marker building for comment export (#84): folding, merging, CSV."""
from datetime import datetime, timezone

from apps.api.services.comment_export import CommentRow, build_markers, snap_fps, to_csv

SPEC = snap_fps(25.0)


def _row(i, *, parent=None, tc=None, tc_end=None, resolved=False, body="Note", author="Jane"):
    return CommentRow(
        id=f"c{i}", parent_id=parent, author_name=author,
        author_email=f"{author.lower()}@x.io", body=body,
        timecode_start=tc, timecode_end=tc_end, resolved=resolved,
        created_at=datetime(2026, 7, 13, 12, 0, i, tzinfo=timezone.utc),
        version_number=2,
    )


def test_marker_with_folded_nested_replies():
    rows = [
        _row(1, tc=2.52, body="Fix the logo"),
        _row(2, parent="c1", author="Bob", body="Agreed"),
        _row(3, parent="c2", author="Jane", body="Done"),
    ]
    (m,) = build_markers(rows, SPEC)
    assert m.frames == 63
    assert m.text == "Jane: Fix the logo"
    assert m.note == "— Bob: Agreed\n— Jane: Done"


def test_same_frame_comments_merge_into_one_marker():
    rows = [_row(1, tc=1.0, body="A"), _row(2, tc=1.0, body="B")]
    (m,) = build_markers(rows, SPEC)
    assert m.text == "Jane: A — Jane: B"


def test_range_duration_and_resolved_filter():
    rows = [_row(1, tc=1.0, tc_end=3.0), _row(2, tc=5.0, resolved=True)]
    markers = build_markers(rows, SPEC, include_resolved=False)
    assert len(markers) == 1
    assert markers[0].duration_frames == 50


def test_untimecoded_excluded_from_markers_but_in_csv():
    rows = [_row(1, tc=None, body="General note")]
    assert build_markers(rows, SPEC) == []
    csv_text = to_csv(rows, SPEC)
    assert "General note" in csv_text
    assert csv_text.splitlines()[0].startswith("comment_id,")


def test_csv_smpte_column_blank_without_spec():
    csv_text = to_csv([_row(1, tc=2.0)], None)
    line = csv_text.splitlines()[1]
    assert ",2.0," in line       # seconds still present
    assert ",00:00:" not in line  # no SMPTE without fps
