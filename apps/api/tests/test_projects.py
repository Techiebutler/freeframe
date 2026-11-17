"""
Project endpoint tests.

DB is mocked; auth is bypassed via auth_headers fixture.
The projects router uses POST /projects (with org_id in body) and GET /projects.
"""
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from apps.api.models.project import ProjectType, ProjectRole


def _mock_project(
    org_id: uuid.UUID,
    created_by: uuid.UUID,
    name: str = "Test Project",
) -> MagicMock:
    p = MagicMock()
    p.id = uuid.uuid4()
    p.org_id = org_id
    p.team_id = None
    p.name = name
    p.description = None
    p.project_type = ProjectType.personal
    p.created_by = created_by
    p.created_at = datetime.now(timezone.utc)
    p.deleted_at = None
    p.is_public = False
    p.poster_url = None
    p.poster_s3_key = None
    p.asset_count = 0
    p.storage_bytes = 0
    p.member_count = 1
    p.role = None
    p.autoreview_brand_slug = None
    return p


def _mock_project_member(project_id: uuid.UUID, user_id: uuid.UUID, role: ProjectRole = ProjectRole.owner) -> MagicMock:
    m = MagicMock()
    m.id = uuid.uuid4()
    m.project_id = project_id
    m.user_id = user_id
    m.role = role
    m.invited_by = None
    m.deleted_at = None
    return m


def test_create_project(client, auth_headers, mock_db, test_user):
    """POST /projects — a superadmin can create a workspace (201)."""
    test_user.is_superadmin = True  # only admins create workspaces now
    org_id = uuid.uuid4()

    def _refresh_side_effect(obj):
        obj.id = uuid.uuid4()
        obj.created_at = datetime.now(timezone.utc)
        obj.deleted_at = None
        obj.team_id = None
        obj.description = None
        obj.project_type = ProjectType.personal
        obj.is_public = False
        obj.poster_url = None
        obj.created_by = test_user.id
        obj.org_id = org_id
        obj.name = "Test Project"

    mock_db.refresh.side_effect = _refresh_side_effect

    resp = client.post(
        "/projects",
        json={"name": "Test Project", "org_id": str(org_id)},
        headers=auth_headers,
    )
    assert resp.status_code == 201
    assert resp.json()["name"] == "Test Project"


def test_create_project_forbidden_for_a_non_admin(client, auth_headers, mock_db, test_user):
    """POST /projects — an editor (non-superadmin) cannot create a workspace. Editors file every
    hand-in into an existing workspace via /handin; per-card projects were what made a share link
    show nothing while the videos sat in a folder elsewhere (2026-09-14 hand-in cleanup)."""
    test_user.is_superadmin = False
    resp = client.post(
        "/projects",
        json={"name": "Do not buy the levide knee - Week 6", "org_id": str(uuid.uuid4())},
        headers=auth_headers,
    )
    assert resp.status_code == 403
    assert "workspace" in resp.json()["detail"].lower()


def test_list_projects(client, auth_headers, mock_db, test_user):
    """GET /projects — returns empty list when no memberships."""
    # The list_projects router does complex joins (memberships, asset counts,
    # storage, member counts).  With a mock DB every chained call returns the
    # same MagicMock, so the simplest reliable assertion is an empty result.
    mock_db.all.return_value = []  # no memberships → no projects

    resp = client.get("/projects", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json() == []


def test_get_project(client, auth_headers, mock_db, test_user):
    """GET /projects/{project_id} — returns project for member."""
    org_id = uuid.uuid4()
    proj = _mock_project(org_id, test_user.id)
    member = _mock_project_member(proj.id, test_user.id)

    call_count = 0

    def _first_side_effect():
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return proj
        return member

    mock_db.first.side_effect = _first_side_effect

    resp = client.get(f"/projects/{proj.id}", headers=auth_headers)
    assert resp.status_code == 200


def test_get_project_not_member(client, auth_headers, mock_db, test_user):
    """GET /projects/{project_id} — 403 if user is not a member."""
    org_id = uuid.uuid4()
    proj = _mock_project(org_id, test_user.id)

    call_count = 0

    def _first_side_effect():
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return proj
        return None  # no membership

    mock_db.first.side_effect = _first_side_effect

    resp = client.get(f"/projects/{proj.id}", headers=auth_headers)
    assert resp.status_code == 403


def test_delete_project(client, auth_headers, mock_db, test_user):
    """DELETE /projects/{project_id} — owner can delete, returns 204."""
    org_id = uuid.uuid4()
    proj = _mock_project(org_id, test_user.id)
    member = _mock_project_member(proj.id, test_user.id, ProjectRole.owner)

    call_count = 0

    def _first_side_effect():
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return proj
        return member

    mock_db.first.side_effect = _first_side_effect

    resp = client.delete(f"/projects/{proj.id}", headers=auth_headers)
    assert resp.status_code == 204


def test_update_project(client, auth_headers, mock_db, test_user):
    """PATCH /projects/{project_id} — owner can update name."""
    org_id = uuid.uuid4()
    proj = _mock_project(org_id, test_user.id, "Old Name")
    member = _mock_project_member(proj.id, test_user.id, ProjectRole.owner)

    call_count = 0

    def _first_side_effect():
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return proj  # _get_project
        return member    # _require_project_owner

    mock_db.first.side_effect = _first_side_effect

    def _refresh_side_effect(obj):
        obj.name = "New Name"

    mock_db.refresh.side_effect = _refresh_side_effect

    resp = client.patch(
        f"/projects/{proj.id}",
        json={"name": "New Name"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "New Name"


def test_auto_poster_keys_picks_newest_asset_per_project():
    """_auto_poster_keys reduces the ordered rows to the newest asset's thumbnail
    per project. The query orders newest-asset-first, so the first row seen for a
    project wins and later (older) rows for it are ignored."""
    from unittest.mock import patch
    from apps.api.routers import projects as projects_router

    project_a, project_b = uuid.uuid4(), uuid.uuid4()
    # Rows as the query would yield them: grouped by project, newest asset first.
    ordered_rows = [
        (project_a, "thumbs/a-newest.jpg"),
        (project_a, "thumbs/a-older.jpg"),
        (project_b, "thumbs/b-newest.jpg"),
    ]

    chain = MagicMock()
    for method in ("query", "join", "filter", "group_by", "order_by"):
        getattr(chain, method).return_value = chain
    chain.subquery.return_value = MagicMock()
    chain.all.return_value = ordered_rows

    db = MagicMock()
    db.query.return_value = chain

    result = projects_router._auto_poster_keys(db, [project_a, project_b])

    assert result == {
        project_a: "thumbs/a-newest.jpg",
        project_b: "thumbs/b-newest.jpg",
    }


def test_auto_poster_keys_empty_without_projects():
    """No projects → no query, empty map."""
    from apps.api.routers import projects as projects_router

    db = MagicMock()
    assert projects_router._auto_poster_keys(db, []) == {}
    db.query.assert_not_called()

# ── settings.require_project_description_pattern ────────────────────────────────────────────
#
# Off by default, so nothing changes for an instance that does not set it. When it is set, a
# project cannot be created - or edited - without whatever the pattern asks for, which is how an
# automation reading projects over the API can find its way back to the brief.

def test_description_requirement_is_off_by_default():
    from apps.api.routers.projects import _check_description_requirement
    from apps.api.config import settings

    original = settings.require_project_description_pattern
    settings.require_project_description_pattern = ""
    try:
        _check_description_requirement(None)          # must not raise
        _check_description_requirement("anything")
    finally:
        settings.require_project_description_pattern = original


def test_description_requirement_rejects_a_missing_link():
    import pytest
    from fastapi import HTTPException
    from apps.api.routers.projects import _check_description_requirement
    from apps.api.config import settings

    original = (settings.require_project_description_pattern, settings.require_project_description_hint)
    settings.require_project_description_pattern = r"trello\.com/c/"
    settings.require_project_description_hint = "Paste the Trello card link."
    try:
        with pytest.raises(HTTPException) as e:
            _check_description_requirement("no link here")
        assert e.value.status_code == 400
        # The message has to say what to paste; "invalid description" sends people hunting for a
        # formatting rule.
        assert "Trello card link" in e.value.detail

        with pytest.raises(HTTPException):
            _check_description_requirement(None)

        # And accepts a real one, wherever it sits in the text, in either case.
        _check_description_requirement("Brief: https://trello.com/c/m8O3AF67/80-bsgv17")
        _check_description_requirement("HTTPS://TRELLO.COM/C/abc123 - winter campaign")
    finally:
        settings.require_project_description_pattern, settings.require_project_description_hint = original

# ── the standing share link for an automation ────────────────────────────────────────────────
#
# Auto Review has no account, so it can only see a project somebody shared with it. Creating that
# link by hand meant one folder had one and every other project was unwatched. These tests pin
# both halves - that it is OFF by default, and that when on it creates a link with the two
# switches that have actually blocked real reviews.

def test_no_standing_link_when_no_webhook_is_configured():
    from apps.api.services import automation_share
    from apps.api.config import settings
    settings.automation_share_webhook_url = ""
    assert automation_share.is_enabled() is False
    assert automation_share.create_standing_link(MagicMock(), uuid.uuid4(), uuid.uuid4()) is None


def test_the_standing_link_can_comment_and_download():
    # Not decoration. Without commenting the review cannot be posted; without downloads only the
    # streaming copy exists, which cannot be analysed. Both have silently blocked real reviews.
    from apps.api.services import automation_share
    from apps.api.config import settings
    from apps.api.models.share import SharePermission
    settings.automation_share_webhook_url = "https://example.invalid/hook"
    link = automation_share.create_standing_link(MagicMock(), uuid.uuid4(), uuid.uuid4())
    assert link.permission == SharePermission.comment
    assert link.allow_download is True
    assert link.expires_at is None      # a standing link that dies takes the reviews with it
    assert len(link.token) >= 32
    settings.automation_share_webhook_url = ""


def test_a_failing_webhook_never_breaks_project_creation():
    # A link the automation never hears about is an unwatched project. A project that could not be
    # created is an editor who cannot work. Only one of those is acceptable.
    from apps.api.services import automation_share
    from apps.api.config import settings
    settings.automation_share_webhook_url = "https://example.invalid/hook"
    project = MagicMock()
    project.id = uuid.uuid4()
    project.name = "BSG_V7"
    project.description = "https://trello.com/c/R7TzoNY1"
    link = MagicMock()
    link.token = "tok"
    with patch("apps.api.services.automation_share.httpx.post", side_effect=RuntimeError("down")):
        automation_share.announce(project, link)   # must not raise
    settings.automation_share_webhook_url = ""


def test_the_announcement_carries_what_identifies_the_brief():
    from apps.api.services import automation_share
    from apps.api.config import settings
    settings.automation_share_webhook_url = "https://example.invalid/hook"
    settings.automation_share_webhook_secret = "s3cret"
    project = MagicMock()
    project.id = uuid.uuid4()
    project.name = "BSG_V7"
    project.description = "https://trello.com/c/R7TzoNY1"
    link = MagicMock()
    link.token = "tok"
    with patch("apps.api.services.automation_share.httpx.post") as post:
        automation_share.announce(project, link)
    sent = post.call_args.kwargs["json"]
    # The description is how the automation works out which brand and which card this is.
    assert sent["description"] == "https://trello.com/c/R7TzoNY1"
    assert sent["share_token"] == "tok"
    assert post.call_args.kwargs["headers"]["authorization"] == "Bearer s3cret"
    settings.automation_share_webhook_url = ""
    settings.automation_share_webhook_secret = ""


# ── asset-ready webhook ──────────────────────────────────────────────────────────────────────
#
# Without this the automation polls every ten minutes, so half of every wait is spent on a file
# that was ready the whole time. It cannot hold an SSE connection open - it is a Worker.

def test_no_asset_ready_call_when_the_webhook_is_unconfigured():
    from apps.api.services import automation_share
    from apps.api.config import settings
    settings.automation_share_webhook_url = ""
    with patch("apps.api.services.automation_share.httpx.post") as post:
        automation_share.announce_asset_ready(MagicMock(), MagicMock(), uuid.uuid4())
    post.assert_not_called()


def test_no_asset_ready_call_when_the_project_has_no_standing_link():
    # Only projects the automation was given a link for. Everything else is none of its business.
    from apps.api.services import automation_share
    from apps.api.config import settings
    settings.automation_share_webhook_url = "https://example.invalid/project-registered"
    db = MagicMock()
    db.query.return_value.filter.return_value.order_by.return_value.first.return_value = None
    with patch("apps.api.services.automation_share.httpx.post") as post:
        automation_share.announce_asset_ready(db, MagicMock(), uuid.uuid4())
    post.assert_not_called()
    settings.automation_share_webhook_url = ""


def test_asset_ready_names_the_asset_and_its_share():
    from apps.api.services import automation_share
    from apps.api.config import settings
    settings.automation_share_webhook_url = "https://example.invalid/project-registered"
    link = MagicMock(); link.token = "tok"
    db = MagicMock()
    db.query.return_value.filter.return_value.order_by.return_value.first.return_value = link
    asset = MagicMock(); asset.id = uuid.uuid4(); asset.project_id = uuid.uuid4(); asset.name = "Char1.mp4"
    vid = uuid.uuid4()
    with patch("apps.api.services.automation_share.httpx.post") as post:
        automation_share.announce_asset_ready(db, asset, vid)
    sent = post.call_args.kwargs["json"]
    assert sent["asset_id"] == str(asset.id)
    assert sent["share_token"] == "tok"
    # A different endpoint from project registration - it is a different event.
    assert post.call_args.args[0].endswith("/asset-ready")
    settings.automation_share_webhook_url = ""


def test_a_failing_asset_ready_webhook_never_fails_the_transcode():
    from apps.api.services import automation_share
    from apps.api.config import settings
    settings.automation_share_webhook_url = "https://example.invalid/project-registered"
    link = MagicMock(); link.token = "tok"
    db = MagicMock()
    db.query.return_value.filter.return_value.order_by.return_value.first.return_value = link
    with patch("apps.api.services.automation_share.httpx.post", side_effect=RuntimeError("down")):
        automation_share.announce_asset_ready(db, MagicMock(), uuid.uuid4())   # must not raise
    settings.automation_share_webhook_url = ""
