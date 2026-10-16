"""The project grid shows each asset's comment count, as share links do.

The count is what the asset's comment panel shows for the version the card
represents: live comments, public and internal, with their replies.
"""
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest


# ── what is counted (live Postgres: a recursive query) ───────────────────────

def _seed(real_db):
    from apps.api.models.user import User
    from apps.api.models.project import Project, ProjectType
    from apps.api.models.asset import Asset, AssetType, AssetVersion, ProcessingStatus

    owner = User(email=f"acc-{uuid.uuid4()}@t.local", name="t")
    real_db.add(owner); real_db.flush()
    project = Project(name="t", project_type=ProjectType.personal, created_by=owner.id)
    real_db.add(project); real_db.flush()
    asset = Asset(project_id=project.id, name="t", asset_type=AssetType.video, created_by=owner.id)
    real_db.add(asset); real_db.flush()
    versions = []
    for n in (1, 2):
        v = AssetVersion(asset_id=asset.id, version_number=n,
                         processing_status=ProcessingStatus.ready, created_by=owner.id)
        real_db.add(v); real_db.flush()
        versions.append(v)
    return owner, asset, versions


def _comment(real_db, owner, asset, version, parent=None, **kw):
    from apps.api.models.comment import Comment
    c = Comment(asset_id=asset.id, version_id=version.id, author_id=owner.id, body="c",
                visibility=kw.pop("visibility", "public"),
                parent_id=parent.id if parent else None, **kw)
    real_db.add(c); real_db.flush()
    return c


def test_counts_comments_and_replies_public_and_internal(real_db):
    from apps.api.routers.assets import _comment_counts

    owner, asset, (v1, v2) = _seed(real_db)
    top = _comment(real_db, owner, asset, v2)
    _comment(real_db, owner, asset, v2, parent=top)
    _comment(real_db, owner, asset, v2, visibility="internal")
    _comment(real_db, owner, asset, v1)  # another version: not this card's

    assert _comment_counts(real_db, [v2.id]) == {v2.id: 3}
    assert _comment_counts(real_db, [v1.id, v2.id]) == {v1.id: 1, v2.id: 3}


def test_deleted_comments_and_their_replies_are_not_counted(real_db):
    from apps.api.routers.assets import _comment_counts

    owner, asset, (_, v2) = _seed(real_db)
    gone = _comment(real_db, owner, asset, v2, deleted_at=datetime.now(timezone.utc))
    _comment(real_db, owner, asset, v2, parent=gone)  # the panel can't reach it
    live = _comment(real_db, owner, asset, v2)
    _comment(real_db, owner, asset, v2, parent=live, deleted_at=datetime.now(timezone.utc))

    assert _comment_counts(real_db, [v2.id]) == {v2.id: 1}


def test_replies_stop_at_the_depth_the_panel_shows(real_db):
    from apps.api.models.comment import COMMENT_TREE_MAX_DEPTH
    from apps.api.routers.assets import _comment_counts

    owner, asset, (_, v2) = _seed(real_db)
    parent = _comment(real_db, owner, asset, v2)
    for _ in range(COMMENT_TREE_MAX_DEPTH + 2):
        parent = _comment(real_db, owner, asset, v2, parent=parent)

    assert _comment_counts(real_db, [v2.id]) == {v2.id: COMMENT_TREE_MAX_DEPTH + 1}


def test_no_versions_costs_no_query():
    from apps.api.routers.assets import _comment_counts
    db = MagicMock()
    assert _comment_counts(db, []) == {}
    db.query.assert_not_called()


# ── the list response ────────────────────────────────────────────────────────

def test_the_asset_list_carries_each_assets_comment_count():
    """The project grid's list: every asset gets its displayed version's count,
    from one query for the whole list."""
    from apps.api.models.asset import AssetType, AssetStatus, ProcessingStatus
    from apps.api.routers.assets import _build_asset_responses_bulk

    now = datetime.now(timezone.utc)
    project_id = uuid.uuid4()

    def asset(name):
        a = MagicMock()
        a.id = uuid.uuid4(); a.project_id = project_id; a.name = name
        a.description = None; a.asset_type = AssetType.video; a.status = AssetStatus.in_review
        a.rating = None; a.assignee_id = None; a.folder_id = None; a.due_date = None
        a.keywords = []; a.created_by = uuid.uuid4(); a.created_at = now; a.updated_at = now
        # Read by AssetResponse.model_validate before the builder sets them.
        a.latest_version = None; a.thumbnail_url = None; a.comment_count = 0
        return a

    def version(a):
        v = MagicMock()
        v.id = uuid.uuid4(); v.asset_id = a.id
        return v

    a1, a2, a3 = asset("Hero"), asset("B-roll"), asset("Just created")
    v1, v2 = version(a1), version(a2)  # a3 has no version yet

    db = MagicMock()
    db.query.return_value = db
    for m in ("filter", "join", "group_by"):
        getattr(db, m).return_value = db
    # Newest version per asset (twice: any, then viewable), then their files.
    db.all.side_effect = [[v1, v2], [v1, v2], []]

    with patch("apps.api.routers.assets._comment_counts", return_value={v1.id: 4}) as counts, \
         patch("apps.api.routers.assets.AssetVersionResponse.model_validate",
               side_effect=lambda v: MagicMock(files=[])):
        result = _build_asset_responses_bulk([a1, a2, a3], db)

    assert {r.name: r.comment_count for r in result} == {"Hero": 4, "B-roll": 0, "Just created": 0}
    counts.assert_called_once()
    assert set(counts.call_args.args[1]) == {v1.id, v2.id}


def test_the_comment_count_is_in_the_asset_schema():
    from apps.api.schemas.asset import AssetResponse
    assert AssetResponse.model_fields["comment_count"].default == 0
