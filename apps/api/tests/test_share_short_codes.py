"""Tests for short share codes.

Every share link is issued a short base62 code at creation. Codes live under the
web app's `/s/` prefix and are resolved server-side through
`GET /resolve/{short_code}`, which the `/s/[code]` route calls. A known code 302s
to the share page; an unknown or deleted code answers 404 so the route can show
the share page's "Link not found" state. Dashboard URLs and share emails prefer
the short URL whenever a code exists, falling back to the full token URL.
"""
import re
import uuid
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from fastapi.responses import RedirectResponse
from unittest.mock import MagicMock

from apps.api.routers.share import (
    _generate_unique_short_code,
    _short_share_url,
    resolve_short_code,
)
from apps.api.utils.short_code import CODE_LENGTH, generate_short_code


def _link(short_code=None, token=None):
    link = MagicMock()
    link.short_code = short_code
    link.token = token or "tok_" + uuid.uuid4().hex
    return link


# ─── Code generation ──────────────────────────────────────────────────────────

def test_generate_short_code_length_and_alphabet():
    for _ in range(50):
        code = generate_short_code()
        assert len(code) == CODE_LENGTH == 8
        assert re.fullmatch(r"[A-Za-z0-9]{8}", code)


def test_generate_short_code_is_random():
    assert len({generate_short_code() for _ in range(200)}) == 200


def test_generate_unique_short_code_returns_when_absent(mock_db):
    mock_db.first.return_value = None  # no collision
    assert len(_generate_unique_short_code(mock_db)) == 8


def test_generate_unique_short_code_retries_on_collision(mock_db):
    # First two candidates collide, third is free.
    mock_db.first.side_effect = [MagicMock(), MagicMock(), None]
    code = _generate_unique_short_code(mock_db)
    assert len(code) == 8
    assert mock_db.first.call_count == 3


def test_generate_unique_short_code_raises_after_retries(mock_db):
    mock_db.first.return_value = MagicMock()  # always collides
    with pytest.raises(RuntimeError):
        _generate_unique_short_code(mock_db)


# ─── URL preference ───────────────────────────────────────────────────────────

def test_short_share_url_prefers_short_code(monkeypatch):
    from apps.api.config import settings
    monkeypatch.setattr(settings, "frontend_url", "https://example.com")
    assert _short_share_url(_link(short_code="AbC12345")) == "https://example.com/s/AbC12345"


def test_short_share_url_keeps_the_subpath(monkeypatch):
    """FRONTEND_URL may carry a path (sub-path deployments); the code sits inside
    that path, under /s/."""
    from apps.api.config import settings
    monkeypatch.setattr(settings, "frontend_url", "https://example.com/freeframe")
    assert _short_share_url(_link(short_code="AbC12345")) == "https://example.com/freeframe/s/AbC12345"


def test_short_share_url_falls_back_to_token(monkeypatch):
    from apps.api.config import settings
    monkeypatch.setattr(settings, "frontend_url", "https://example.com")
    assert _short_share_url(_link(short_code=None, token="token123")) == "https://example.com/share/token123"


def test_short_share_url_does_not_double_the_slash(monkeypatch):
    """A FRONTEND_URL ending in `/` must not produce `//share/...`."""
    from apps.api.config import settings
    monkeypatch.setattr(settings, "frontend_url", "https://example.com/")
    assert _short_share_url(_link(short_code="AbC12345")) == "https://example.com/s/AbC12345"
    assert _short_share_url(_link(short_code=None, token="token123")) == "https://example.com/share/token123"


# ─── /resolve/{short_code} ────────────────────────────────────────────────────

def test_resolve_known_code_redirects_to_share_page(client, mock_db, monkeypatch):
    from apps.api.config import settings
    monkeypatch.setattr(settings, "frontend_url", "https://host.example")
    mock_db.first.return_value = _link(short_code="AbC12345", token="token123")

    resp = client.get("/resolve/AbC12345", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"] == "https://host.example/share/token123"


def test_resolve_unknown_code_is_not_found(client, mock_db, monkeypatch):
    from apps.api.config import settings
    monkeypatch.setattr(settings, "frontend_url", "https://host.example")
    mock_db.first.return_value = None

    resp = client.get("/resolve/zzzzzzzz", follow_redirects=False)
    assert resp.status_code == 404


def test_resolve_preserves_a_subpath_frontend(client, mock_db, monkeypatch):
    """A sub-path deployment (FRONTEND_URL=https://host/freeframe) must redirect
    to the share page *inside* the sub-path."""
    from apps.api.config import settings
    monkeypatch.setattr(settings, "frontend_url", "https://host/freeframe")
    mock_db.first.return_value = _link(short_code="AbC12345", token="token123")

    resp = client.get("/resolve/AbC12345", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"] == "https://host/freeframe/share/token123"


def test_resolve_excludes_deleted_links(mock_db, monkeypatch):
    """The query filters deleted_at IS NULL — a deleted link's code must not resolve."""
    from apps.api.config import settings
    monkeypatch.setattr(settings, "frontend_url", "https://host.example")
    mock_db.first.return_value = None

    with pytest.raises(HTTPException) as exc:
        resolve_short_code("AbC12345", db=mock_db)
    assert exc.value.status_code == 404

    exprs = [arg for call in mock_db.filter.call_args_list for arg in call[0]]
    column_names = [str(getattr(getattr(f, "left", None), "name", "")) for f in exprs]
    assert "deleted_at" in column_names


def test_resolve_route_is_rate_limited():
    """The code space is only 62^8; without a rate limit it could be enumerated.
    Reminds a future edit that removes the dependency."""
    from apps.api.routers.share import router
    route = next(
        r for r in router.routes if getattr(r, "path", "") == "/resolve/{short_code}"
    )
    assert route.dependant.dependencies


# ─── Create endpoints assign codes (real Postgres) ────────────────────────────

def _seed_project(db):
    from apps.api.models.user import User
    from apps.api.models.project import Project, ProjectType, ProjectMember, ProjectRole
    from apps.api.models.asset import Asset, AssetType
    from apps.api.models.folder import Folder

    owner = User(email=f"short-{uuid.uuid4()}@t.local", name="owner")
    recipient = User(email=f"short-r-{uuid.uuid4()}@t.local", name="recipient")
    db.add_all([owner, recipient]); db.flush()

    project = Project(name="t", project_type=ProjectType.personal, created_by=owner.id)
    db.add(project); db.flush()
    db.add(ProjectMember(project_id=project.id, user_id=owner.id, role=ProjectRole.owner))
    db.flush()

    asset = Asset(project_id=project.id, name="a", asset_type=AssetType.video, created_by=owner.id)
    folder = Folder(project_id=project.id, name="f", created_by=owner.id)
    db.add_all([asset, folder]); db.flush()

    return owner, recipient, project, asset, folder


def test_every_create_endpoint_assigns_an_eight_char_code(real_db):
    from apps.api.routers.share import (
        create_share_link,
        create_folder_share_link,
        create_project_share_link,
        create_multi_share_link,
    )
    from apps.api.schemas.share import ShareLinkCreate, MultiShareCreate

    owner, _recipient, project, asset, folder = _seed_project(real_db)
    body = ShareLinkCreate()

    links = [
        create_share_link(asset.id, body, db=real_db, current_user=owner),
        create_folder_share_link(folder.id, body, db=real_db, current_user=owner),
        create_project_share_link(project.id, body, db=real_db, current_user=owner),
        create_multi_share_link(
            project.id, MultiShareCreate(asset_ids=[asset.id]), db=real_db, current_user=owner
        ),
    ]

    codes = [link.short_code for link in links]
    assert all(code and len(code) == 8 and re.fullmatch(r"[A-Za-z0-9]{8}", code) for code in codes)
    assert len(set(codes)) == 4


def test_list_and_response_carry_short_code(real_db):
    from apps.api.routers.share import (
        _share_link_response,
        create_share_link,
        list_project_share_links,
    )
    from apps.api.schemas.share import ShareLinkCreate

    owner, _recipient, project, asset, _folder = _seed_project(real_db)
    link = create_share_link(asset.id, ShareLinkCreate(), db=real_db, current_user=owner)

    response = _share_link_response(link)
    assert response.short_code == link.short_code

    items = list_project_share_links(project.id, search=None, db=real_db, current_user=owner)
    assert any(item.short_code == link.short_code for item in items), (
        "the project share-links list must select and return short_code"
    )


def test_resolve_live_and_deleted_links_real_db(real_db, monkeypatch):
    from apps.api.config import settings
    from apps.api.routers.share import create_share_link
    from apps.api.schemas.share import ShareLinkCreate

    monkeypatch.setattr(settings, "frontend_url", "https://host.example")
    owner, _recipient, _project, asset, _folder = _seed_project(real_db)
    link = create_share_link(asset.id, ShareLinkCreate(), db=real_db, current_user=owner)

    resolved = resolve_short_code(link.short_code, db=real_db)
    assert isinstance(resolved, RedirectResponse)
    assert resolved.headers["location"] == f"https://host.example/share/{link.token}"

    link.deleted_at = datetime.now(timezone.utc)
    real_db.flush()
    with pytest.raises(HTTPException) as exc:
        resolve_short_code(link.short_code, db=real_db)
    assert exc.value.status_code == 404


# ─── Emails use the short URL ─────────────────────────────────────────────────

def test_share_email_uses_the_short_url(real_db, monkeypatch):
    from apps.api.config import settings
    from apps.api.routers import share as share_router
    from apps.api.routers.share import create_share_link, share_with_user
    from apps.api.schemas.share import DirectShareCreate, ShareLinkCreate

    monkeypatch.setattr(settings, "frontend_url", "https://host.example")
    sent = MagicMock()
    monkeypatch.setattr(share_router, "send_task_safe", sent)

    owner, recipient, _project, asset, _folder = _seed_project(real_db)
    link = create_share_link(asset.id, ShareLinkCreate(), db=real_db, current_user=owner)

    share_with_user(
        asset.id,
        DirectShareCreate(user_id=recipient.id, share_token=link.token),
        db=real_db,
        current_user=owner,
    )

    assert sent.called
    asset_link = sent.call_args.kwargs["asset_link"]
    assert asset_link == f"https://host.example/s/{link.short_code}"
