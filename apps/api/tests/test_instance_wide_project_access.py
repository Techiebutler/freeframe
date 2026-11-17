"""Instance-wide project access (INSTANCE_WIDE_PROJECT_ACCESS).

Off, nothing changes. On, every account holds `editor` on every project and
superadmins hold `owner`, with no membership row behind it - and people who
arrive through a share link still hold nothing at all, which is the property
that keeps this from widening what clients can see.
"""
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from apps.api.models.project import ProjectRole, ProjectType
from apps.api.models.share import SharePermission
from apps.api.services.permissions import (
    can_access_asset,
    effective_project_role,
    implicit_project_role,
    require_project_role,
)


@pytest.fixture
def instance_wide(monkeypatch):
    monkeypatch.setattr("apps.api.config.settings.instance_wide_project_access", True)


def _user(is_superadmin: bool = False) -> MagicMock:
    u = MagicMock()
    u.id = uuid.uuid4()
    u.is_superadmin = is_superadmin
    return u


def _db(member=None) -> MagicMock:
    """A session whose membership lookup returns `member` (None = not a member)."""
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.first.return_value = member
    return db


def _member(role: ProjectRole) -> MagicMock:
    m = MagicMock()
    m.role = role
    return m


# ── Off: nothing changes ──────────────────────────────────────────────────────

def test_off_grants_nothing():
    assert implicit_project_role(_user()) is None
    assert implicit_project_role(_user(is_superadmin=True)) is None
    assert effective_project_role(_db(), uuid.uuid4(), _user()) is None


def test_off_still_refuses_a_non_member():
    with pytest.raises(HTTPException) as exc:
        require_project_role(_db(), uuid.uuid4(), _user(), ProjectRole.viewer)
    assert exc.value.status_code == 403


# ── On: everyone holds a role everywhere ──────────────────────────────────────

def test_on_gives_every_account_editor(instance_wide):
    assert implicit_project_role(_user()) == ProjectRole.editor
    assert effective_project_role(_db(), uuid.uuid4(), _user()) == ProjectRole.editor


def test_on_gives_superadmins_owner(instance_wide):
    """Without this, a project belongs to whoever created it and nobody else can
    administer it - not even list its members."""
    assert implicit_project_role(_user(is_superadmin=True)) == ProjectRole.owner
    assert effective_project_role(_db(), uuid.uuid4(), _user(is_superadmin=True)) == ProjectRole.owner


def test_on_lets_a_non_member_upload_and_comment(instance_wide):
    """editor clears the two gates that matter: uploads require editor, comments
    require anything above viewer."""
    role = require_project_role(_db(), uuid.uuid4(), _user(), ProjectRole.editor)
    assert role == ProjectRole.editor


def test_on_still_refuses_owner_only_actions_to_a_plain_account(instance_wide):
    """Renaming, deleting and member management stay owner-only."""
    with pytest.raises(HTTPException) as exc:
        require_project_role(_db(), uuid.uuid4(), _user(), ProjectRole.owner)
    assert exc.value.status_code == 403


def test_on_is_a_floor_not_a_ceiling(instance_wide):
    """A membership row that grants more keeps granting more; one that grants
    less must not leave somebody worse off than not being listed at all."""
    user = _user()
    assert effective_project_role(_db(_member(ProjectRole.owner)), uuid.uuid4(), user) == ProjectRole.owner
    assert effective_project_role(_db(_member(ProjectRole.viewer)), uuid.uuid4(), user) == ProjectRole.editor


def test_on_reaches_assets_in_projects_you_were_never_added_to(instance_wide):
    asset = MagicMock()
    asset.created_by = uuid.uuid4()  # somebody else's upload
    asset.project_id = uuid.uuid4()
    assert can_access_asset(_db(), asset, _user()) is True


# ── On: share links are untouched ─────────────────────────────────────────────

@patch("apps.api.routers.comments.validate_share_link_with_session")
def test_on_does_not_open_view_only_share_links(mock_validate, instance_wide, client, mock_db):
    """The setting keys on holding an account. A guest on a view-only link holds
    none, so the link's own permission is still the only thing that decides."""
    link = MagicMock()
    link.permission = SharePermission.view
    mock_validate.return_value = link

    resp = client.post(
        "/share/some-token/comment",
        json={"body": "Can I comment?", "asset_id": str(uuid.uuid4()),
              "guest_name": "A Client", "guest_email": "client@example.com"},
    )

    assert resp.status_code == 403
    assert resp.json()["detail"] == "This share link does not allow commenting"


# ── On: the client is told its role without reading the member list ───────────

def test_on_reports_the_implicit_role_on_the_project_itself(instance_wide, client, auth_headers, mock_db, test_user):
    """The UI decides what to offer from project.role. A non-member holds editor
    now, and GET /projects/{id}/members is not the place that can say so."""
    project = MagicMock()
    project.id = uuid.uuid4()
    project.org_id = uuid.uuid4()
    project.team_id = None
    project.name = "Someone else's brand"
    project.description = None
    project.project_type = ProjectType.personal
    project.created_by = uuid.uuid4()
    project.created_at = datetime.now(timezone.utc)
    project.deleted_at = None
    project.is_public = False
    project.poster_url = None
    project.poster_s3_key = None
    project.asset_count = 0
    project.storage_bytes = 0
    project.member_count = 1
    project.role = None
    project.autoreview_brand_slug = None

    calls = 0

    def _first():
        nonlocal calls
        calls += 1
        return project if calls == 1 else None  # project found, no membership row

    mock_db.first.side_effect = _first

    resp = client.get(f"/projects/{project.id}", headers=auth_headers)

    assert resp.status_code == 200
    assert resp.json()["role"] == "editor"
