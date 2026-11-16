"""A share tile's bubble counts people; Auto Review's own notes are counted apart (2026-11-16).

Seen live: every tile of a fresh Veda delivery showed 9-22 comments that were all Auto Review's, so files nobody
had looked at read as commented on.
"""
import uuid
from unittest.mock import MagicMock

from apps.api.routers.share import _latest_version_comment_counts


def _db(version, rows):
    db = MagicMock()
    versions, counts = MagicMock(), MagicMock()
    versions.filter.return_value.order_by.return_value.first.return_value = version
    counts.filter.return_value.group_by.return_value.all.return_value = rows
    db.query.side_effect = [versions, counts]
    return db


def test_only_auto_review_notes_leave_the_people_bubble_at_zero():
    assert _latest_version_comment_counts(_db(MagicMock(id=uuid.uuid4()), [(True, 9)]), uuid.uuid4()) == (0, 9)


def test_people_and_auto_review_are_counted_apart():
    assert _latest_version_comment_counts(_db(MagicMock(id=uuid.uuid4()), [(False, 1), (True, 9)]), uuid.uuid4()) == (1, 9)


def test_no_ready_version_counts_nothing():
    assert _latest_version_comment_counts(_db(None, []), uuid.uuid4()) == (0, 0)
