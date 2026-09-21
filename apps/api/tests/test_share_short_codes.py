"""Tests for short share codes.

Share links get a 4-character base62 code (`short_code`) at creation. Deployments
resolve root-level codes through the web app, which calls `GET /resolve/{short_code}`
and 302s to the share page. Unknown codes land on the app root. Email links and
dashboard URL display prefer the short URL when a code exists and fall back to the
full token URL. Codes never take a name the web app serves at its root.
"""
import re
import uuid
from pathlib import Path
from unittest.mock import MagicMock

from apps.api.routers.share import _generate_unique_short_code, _short_share_url
from apps.api.utils.short_code import CODE_LENGTH, RESERVED_CODES, generate_short_code


def _link(short_code=None, token=None):
    link = MagicMock()
    link.short_code = short_code
    link.token = token or "tok_" + uuid.uuid4().hex
    return link


# ─── Code generation ──────────────────────────────────────────────────────────

def test_generate_short_code_length_and_alphabet():
    for _ in range(50):
        code = generate_short_code()
        assert len(code) == 4
        assert all(c.isascii() and (c.isalnum()) for c in code)


def test_generate_short_code_skips_reserved_codes(monkeypatch):
    """A candidate that names a web root route is redrawn, not returned."""
    import secrets

    reserved = next(
        w for w in sorted(RESERVED_CODES)
        if len(w) == CODE_LENGTH and w != w[::-1]
    )
    draws = iter(list(reserved) + list("AbC1"))
    monkeypatch.setattr(secrets, "choice", lambda alphabet: next(draws))
    assert generate_short_code() == "AbC1"


def test_every_web_root_route_is_reserved():
    """A 4-char root route in the web app would shadow any share link issued
    that code, so each one must be in RESERVED_CODES. Adding a route without
    reserving its name fails here instead of at click time."""
    app_dir = Path(__file__).resolve().parents[3] / "apps" / "web" / "app"
    assert app_dir.is_dir(), f"web app directory not found at {app_dir}"
    pattern = re.compile(rf"^[A-Za-z0-9]{{{CODE_LENGTH}}}$")
    # Route groups `(auth)`, private folders `_x` and dynamic `[code]` are not
    # literal URL segments.
    offenders = sorted(
        entry.name
        for entry in app_dir.iterdir()
        if entry.is_dir()
        and not entry.name.startswith(("(", "_", "@", "["))
        and pattern.match(entry.name)
        and entry.name not in RESERVED_CODES
    )
    assert not offenders, (
        f"root route(s) {offenders} can collide with a generated short code; "
        "add them to RESERVED_CODES in apps/api/utils/short_code.py"
    )


def test_generate_unique_short_code_returns_when_absent(mock_db):
    mock_db.first.return_value = None  # no collision
    code = _generate_unique_short_code(mock_db)
    assert len(code) == 4


def test_generate_unique_short_code_retries_on_collision(mock_db):
    # First two candidates collide, third is free.
    mock_db.first.side_effect = [MagicMock(), MagicMock(), None]
    code = _generate_unique_short_code(mock_db)
    assert len(code) == 4
    assert mock_db.first.call_count == 3


def test_generate_unique_short_code_raises_after_retries(mock_db):
    mock_db.first.return_value = MagicMock()  # always collides
    try:
        _generate_unique_short_code(mock_db)
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected RuntimeError after exhausting retries")


# ─── URL preference ───────────────────────────────────────────────────────────

def test_short_share_url_prefers_short_code(monkeypatch):
    from apps.api.config import settings
    monkeypatch.setattr(settings, "frontend_url", "https://example.com")
    link = _link(short_code="AbC1")
    assert _short_share_url(link) == "https://example.com/AbC1"


def test_short_share_url_uses_deployment_root_for_subpath(monkeypatch):
    """FRONTEND_URL may carry a path (sub-path deployments); short codes
    resolve at the root of the deployment, inside that path."""
    from apps.api.config import settings
    monkeypatch.setattr(settings, "frontend_url", "https://example.com/freeframe")
    link = _link(short_code="AbC1")
    assert _short_share_url(link) == "https://example.com/freeframe/AbC1"


def test_short_share_url_falls_back_to_token(monkeypatch):
    from apps.api.config import settings
    monkeypatch.setattr(settings, "frontend_url", "https://example.com")
    link = _link(short_code=None, token="token123")
    assert _short_share_url(link) == "https://example.com/share/token123"


# ─── /resolve/{short_code} ────────────────────────────────────────────────────

def test_resolve_known_code_redirects_to_share_page(client, mock_db):
    link = _link(short_code="AbC1", token="token123")
    mock_db.first.return_value = link

    resp = client.get("/resolve/AbC1", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"] == "http://localhost:3000/share/token123"


def test_resolve_unknown_code_lands_on_app_root(client, mock_db):
    mock_db.first.return_value = None

    resp = client.get("/resolve/zzzz", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"] == "http://localhost:3000/"


def test_resolve_redirect_preserves_subpath_frontend(client, mock_db, monkeypatch):
    """A sub-path deployment (FRONTEND_URL=https://host/freeframe) must be
    redirected to the share page *inside* the sub-path."""
    from apps.api.config import settings
    monkeypatch.setattr(settings, "frontend_url", "https://host/freeframe")
    link = _link(short_code="AbC1", token="token123")
    mock_db.first.return_value = link

    resp = client.get("/resolve/AbC1", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"] == "https://host/freeframe/share/token123"


def test_resolve_excludes_deleted_links(client, mock_db):
    """The query filters deleted_at IS NULL — a deleted link's code must not resolve."""
    mock_db.first.return_value = None
    resp = client.get("/resolve/AbC1", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"] == "http://localhost:3000/"
    # The filter chain must have included the deleted_at guard.
    exprs = [arg for call in mock_db.filter.call_args_list for arg in call[0]]
    column_names = [str(getattr(getattr(f, "left", None), "name", "")) for f in exprs]
    assert "deleted_at" in column_names
