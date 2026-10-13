"""The project's Share Links list is newest first.

The endpoint unions asset, folder and project links, and a UNION ALL has no
order of its own, so without an explicit sort the table came back in whatever
order Postgres produced.
"""
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


def _row(title, created_at):
    return SimpleNamespace(
        id=uuid.uuid4(),
        token=f"tok-{title}",
        title=title,
        description=None,
        is_enabled=True,
        permission="comment",
        share_type="folder",
        target_name=title,
        view_count=0,
        last_viewed_at=None,
        created_at=created_at,
    )


def _chainable_query(rows):
    q = MagicMock()
    for method in ("join", "outerjoin", "filter", "group_by", "union_all"):
        getattr(q, method).return_value = q
    q.all.return_value = rows
    return q


def test_share_links_are_listed_newest_first(client, mock_db, auth_headers):
    now = datetime.now(timezone.utc)
    rows = [
        _row("middle", now - timedelta(days=1)),
        _row("oldest", now - timedelta(days=7)),
        _row("newest", now),
    ]
    mock_db.query.return_value = _chainable_query(rows)

    with patch("apps.api.routers.share.require_project_role"):
        resp = client.get(f"/projects/{uuid.uuid4()}/share-links", headers=auth_headers)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [link["title"] for link in body] == ["newest", "middle", "oldest"]
    assert all(link["created_at"] for link in body)
