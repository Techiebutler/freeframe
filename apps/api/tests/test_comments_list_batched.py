"""Unit tests for the batched comment-tree builder (list endpoint N+1 fix)."""
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

from apps.api.routers.comments import _build_comment_responses_batched

ASSET = uuid.uuid4()
VER = uuid.uuid4()
AUTHOR = uuid.uuid4()
NOW = datetime.now(timezone.utc)


def _comment(cid, parent_id=None, author_id=AUTHOR):
    # Only the fields CommentResponse validates — SimpleNamespace is read via
    # Pydantic from_attributes exactly like an ORM row.
    return SimpleNamespace(
        id=cid, asset_id=ASSET, version_id=VER, parent_id=parent_id,
        author_id=author_id, guest_author_id=None,
        timecode_start=None, timecode_end=None, body="hi", resolved=False,
        visibility="public", created_at=NOW, updated_at=NOW,
    )


def _mock_db(all_side_effect):
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.order_by.return_value = db
    db.all.side_effect = all_side_effect
    return db


def test_batched_builds_nested_tree_with_related_data():
    parent = _comment(uuid.uuid4())
    reply = _comment(uuid.uuid4(), parent_id=parent.id)
    annotation = SimpleNamespace(
        id=uuid.uuid4(), comment_id=parent.id,
        drawing_data={"objects": []}, frame_number=None, carousel_position=None,
    )
    reaction = SimpleNamespace(comment_id=parent.id, emoji="👍", user_id=AUTHOR)
    author = SimpleNamespace(id=AUTHOR, name="Alice", avatar_url=None)

    db = _mock_db([
        [parent, reply],   # all_comments
        [annotation],      # annotations
        [],                # attachments
        [reaction],        # reactions
        [author],          # authors
    ])

    result = _build_comment_responses_batched(ASSET, [parent], db)

    assert len(result) == 1
    top = result[0]
    assert top.id == parent.id
    assert [r.id for r in top.replies] == [reply.id]      # reply nested under parent
    assert top.annotation is not None                      # annotation batch-attached
    assert top.reactions[0].emoji == "👍" and top.reactions[0].count == 1
    assert top.author.name == "Alice"
    assert top.replies[0].author.name == "Alice"           # author loaded once, reused
    assert top.replies[0].annotation is None               # reply had none


def test_batched_uses_a_fixed_number_of_queries_regardless_of_comment_count():
    # 1 top-level + 50 replies must NOT scale the query count (the whole point).
    parent = _comment(uuid.uuid4())
    replies = [_comment(uuid.uuid4(), parent_id=parent.id) for _ in range(50)]
    author = SimpleNamespace(id=AUTHOR, name="Alice", avatar_url=None)

    db = _mock_db([
        [parent, *replies],  # all_comments
        [],                  # annotations
        [],                  # attachments
        [],                  # reactions
        [author],            # authors
    ])

    result = _build_comment_responses_batched(ASSET, [parent], db)

    assert len(result[0].replies) == 50
    # all_comments + annotations + attachments + reactions + authors = 5.
    # No guest query (no guest authors); crucially, nothing per-comment.
    assert db.query.call_count == 5


def test_batched_loads_guest_authors_and_skips_the_user_query():
    # Share/public-link comments are authored by guests (no user row).
    guest_id = uuid.uuid4()
    parent = SimpleNamespace(
        id=uuid.uuid4(), asset_id=ASSET, version_id=VER, parent_id=None,
        author_id=None, guest_author_id=guest_id,
        timecode_start=None, timecode_end=None, body="hi", resolved=False,
        visibility="public", created_at=NOW, updated_at=NOW,
    )
    guest = SimpleNamespace(id=guest_id, name="Guest Reviewer", email="g@example.com")

    # No author_ids → the User query is short-circuited; the guest query runs instead.
    db = _mock_db([
        [parent],  # all_comments
        [],        # annotations
        [],        # attachments
        [],        # reactions
        [guest],   # guests
    ])

    result = _build_comment_responses_batched(ASSET, [parent], db)

    assert result[0].author is None
    assert result[0].guest_author.name == "Guest Reviewer"
    assert result[0].guest_author.email == "g@example.com"


def test_batched_empty_top_level_returns_empty_without_querying():
    db = _mock_db([])
    assert _build_comment_responses_batched(ASSET, [], db) == []
    assert db.query.call_count == 0
