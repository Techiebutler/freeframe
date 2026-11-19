"""The project grid card shows a verdict badge, so asset listings carry the counts.

`verdict_summary` is how many of each verdict the version the card shows holds
(`latest_version`, not the newest row by number), team and external alike. It is
filled for the whole page by one grouped query, never one per asset.

Real Postgres through the real app, on the share-link world from
`test_share_links_trashed_content`. Share listings have their own response
models and must never carry the field: a guest sees no team verdict counts.
"""
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import event

from apps.api.tests.test_share_links_trashed_content import (  # noqa: F401  (fixtures)
    _auth, _seed, client, db,
)

from apps.api.models.approval import Approval, ApprovalStatus
from apps.api.models.asset import Asset, AssetType, AssetVersion, ProcessingStatus
from apps.api.models.project import Project, ProjectMember, ProjectRole, ProjectType
from apps.api.models.user import GuestUser, User

NOBODY = {"approved": 0, "changes_requested": 0, "rejected": 0}


def _add_asset(db, project, owner, name, statuses=(ProcessingStatus.ready,)):
    """An asset with one version per status given, numbered in order."""
    asset = Asset(project_id=project.id, name=name, asset_type=AssetType.video, created_by=owner.id)
    db.add(asset)
    db.flush()
    versions = []
    for n, status in enumerate(statuses, start=1):
        v = AssetVersion(asset_id=asset.id, version_number=n, processing_status=status,
                         created_by=owner.id)
        db.add(v)
        db.flush()
        versions.append(v)
    return asset, versions


def _user(db, name="u"):
    u = User(email=f"{name}-{uuid.uuid4().hex[:8]}@t.local", name=name)
    db.add(u)
    db.flush()
    return u


def _guest(db, name="Dana"):
    g = GuestUser(email=f"g-{uuid.uuid4().hex[:8]}@client.test", name=name)
    db.add(g)
    db.flush()
    return g


def _verdict(db, version, status, *, user=None, guest=None, **kw):
    row = Approval(asset_id=version.asset_id, version_id=version.id,
                   user_id=user.id if user else None,
                   guest_user_id=guest.id if guest else None,
                   status=ApprovalStatus(status), **kw)
    db.add(row)
    db.flush()
    return row


def _listing(client, project, user):
    r = client.get(f"/projects/{project.id}/assets", headers=_auth(user))
    assert r.status_code == 200, r.text
    return {a["name"]: a for a in r.json()}


# ── what is counted ───────────────────────────────────────────────────────────

def test_listing_reports_counts_for_the_latest_version_only(client, db):
    w = _seed(db)
    # w.A already has v1. Three approvals on it must not leak into v2's summary.
    v1 = w.versions[w.A.id]
    v2 = AssetVersion(asset_id=w.A.id, version_number=2, processing_status=ProcessingStatus.ready,
                      created_by=w.owner.id)
    db.add(v2)
    db.flush()
    for who in (w.owner, w.editor, w.viewer):
        _verdict(db, v1, "approved", user=who)
    _verdict(db, v2, "rejected", user=w.owner)
    _verdict(db, v2, "changes_requested", user=w.editor)
    _verdict(db, v2, "approved", guest=_guest(db))  # an external verdict counts too

    expected = {"approved": 1, "changes_requested": 1, "rejected": 1}

    grid = _listing(client, w.project, w.owner)
    assert grid["A"]["latest_version"]["id"] == str(v2.id)
    assert grid["A"]["verdict_summary"] == expected

    # Every way an asset is read back carries the same counts.
    single = client.get(f"/assets/{w.A.id}", headers=_auth(w.owner))
    assert single.status_code == 200, single.text
    assert single.json()["verdict_summary"] == expected

    batch = client.get("/assets/batch", params={"ids": [str(w.A.id)]}, headers=_auth(w.owner))
    assert batch.status_code == 200, batch.text
    assert [a["verdict_summary"] for a in batch.json()] == [expected]

    mine = client.get("/me/assets", params={"filter": "owned", "limit": 100}, headers=_auth(w.owner))
    assert mine.status_code == 200, mine.text
    assert {a["name"]: a["verdict_summary"] for a in mine.json()}["A"] == expected


def test_an_asset_nobody_has_judged_reports_zeros(client, db):
    w = _seed(db)
    bare, _ = _add_asset(db, w.project, w.owner, "just-created", statuses=())  # no version yet

    grid = _listing(client, w.project, w.owner)

    # The same shape as comment_count: present and zero, never null on a team listing.
    assert grid["AF"]["verdict_summary"] == NOBODY
    assert grid["just-created"]["latest_version"] is None
    assert grid["just-created"]["verdict_summary"] == NOBODY
    single = client.get(f"/assets/{bare.id}", headers=_auth(w.owner))
    assert single.json()["verdict_summary"] == NOBODY


def test_the_summary_follows_the_version_the_card_shows(client, db):
    """A v2 that is still uploading is the newest row but not the version shown, so
    the badge must describe v1, whose thumbnail and comment count the card carries."""
    w = _seed(db)
    asset, (v1, v2) = _add_asset(db, w.project, w.owner, "interrupted",
                                 (ProcessingStatus.ready, ProcessingStatus.uploading))
    _verdict(db, v1, "approved", user=w.owner)
    _verdict(db, v2, "rejected", user=w.editor)

    grid = _listing(client, w.project, w.owner)

    assert grid["interrupted"]["latest_version"]["id"] == str(v1.id)
    assert grid["interrupted"]["verdict_summary"] == {"approved": 1, "changes_requested": 0, "rejected": 0}
    single = client.get(f"/assets/{asset.id}", headers=_auth(w.owner))
    assert single.json()["verdict_summary"] == {"approved": 1, "changes_requested": 0, "rejected": 0}


def test_legacy_pending_rows_and_removed_rows_do_not_count(client, db):
    w = _seed(db)
    v1 = w.versions[w.A.id]
    _verdict(db, v1, "pending", user=w.editor)
    _verdict(db, v1, "approved", user=w.viewer, deleted_at=datetime.now(timezone.utc))
    _verdict(db, v1, "rejected", user=w.owner)

    grid = _listing(client, w.project, w.owner)

    assert grid["A"]["verdict_summary"] == {"approved": 0, "changes_requested": 0, "rejected": 1}


# ── one query for the page ────────────────────────────────────────────────────

def _grid_with(db, n):
    """A fresh project of `n` assets, each with two ready versions and verdicts on
    the latest, and its owner."""
    owner = _user(db, "grid-owner")
    project = Project(name=f"grid-{n}", project_type=ProjectType.team, created_by=owner.id)
    db.add(project)
    db.flush()
    db.add(ProjectMember(project_id=project.id, user_id=owner.id, role=ProjectRole.owner))
    db.flush()
    for i in range(n):
        _, (v1, v2) = _add_asset(db, project, owner, f"asset-{i}",
                                 (ProcessingStatus.ready, ProcessingStatus.ready))
        _verdict(db, v1, "rejected", user=owner)
        _verdict(db, v2, "approved", user=owner)
        _verdict(db, v2, "changes_requested", guest=_guest(db))
    return project, owner


def _statements_for_listing(client, db, project, owner):
    _listing(client, project, owner)  # warm up: nothing below should depend on what is cached
    statements = []

    def _record(conn, cursor, statement, *a):
        statements.append(statement)

    engine = db.get_bind().engine
    event.listen(engine, "before_cursor_execute", _record)
    try:
        grid = _listing(client, project, owner)
    finally:
        event.remove(engine, "before_cursor_execute", _record)
    return grid, statements


def test_listing_uses_one_query_for_summaries(client, db):
    one_project, one_owner = _grid_with(db, 1)
    five_project, five_owner = _grid_with(db, 5)

    one_grid, one = _statements_for_listing(client, db, one_project, one_owner)
    five_grid, five = _statements_for_listing(client, db, five_project, five_owner)

    # Every card has its own counts, so the queries were not skipped.
    assert len(one_grid) == 1 and len(five_grid) == 5
    for grid in (one_grid, five_grid):
        for asset in grid.values():
            assert asset["verdict_summary"] == {"approved": 1, "changes_requested": 1, "rejected": 0}

    def on_approvals(statements):
        return [s for s in statements if "FROM approvals" in s]

    assert len(on_approvals(one)) == 1, on_approvals(one)
    assert len(on_approvals(five)) == 1, on_approvals(five)
    # And the page as a whole does not grow with the number of assets.
    assert len(five) == len(one), (len(one), len(five))


# ── who sees it ───────────────────────────────────────────────────────────────

def test_share_listings_never_carry_a_verdict_summary(client, db):
    """A guest must not read the team's verdict counts. Share responses are their
    own models, so the field has to stay out of them even when verdicts exist."""
    w = _seed(db)
    _verdict(db, w.versions[w.AF.id], "rejected", user=w.owner)
    _verdict(db, w.versions[w.A.id], "approved", user=w.editor)
    # The same verdicts are in the team's listing, so the absence below is not vacuous.
    grid = _listing(client, w.project, w.owner)
    assert grid["AF"]["verdict_summary"]["rejected"] == 1
    assert grid["A"]["verdict_summary"]["approved"] == 1

    reached = 0
    for kind in ("asset", "folder", "project", "multi"):
        token = w.links[kind].token
        for path in (f"/share/{token}", f"/share/{token}/assets"):
            r = client.get(path)
            if r.status_code != 200:
                continue
            reached += 1
            assert "verdict_summary" not in r.text, path
    assert reached >= 4, "the share listings were not reached"


def test_no_share_schema_has_a_verdict_summary_field():
    from pydantic import BaseModel
    from apps.api.schemas import share

    models = [m for m in vars(share).values()
              if isinstance(m, type) and issubclass(m, BaseModel) and m is not BaseModel]
    assert models
    assert [m.__name__ for m in models if "verdict_summary" in m.model_fields] == []


def test_the_asset_schema_leaves_the_summary_null_until_a_builder_fills_it():
    from apps.api.schemas.asset import AssetResponse
    assert AssetResponse.model_fields["verdict_summary"].default is None
