"""Tests for crawler-facing share previews (gate + image + thumbnail toggle).

Upstream feature-request contract (maintainer reply, 2026-10-16):

  * `GET /share/{token}/preview` — card data ONLY for links a logged-out
    visitor could already open. Every other state (password, secure,
    disabled, expired, deleted, unknown token) answers
    the SAME uniform 404 with no link-specific text, not even the title.
  * It must NOT log a share "open" and must NOT share the per-IP
    `share_validate` rate-limit bucket.
  * `GET /share/{token}/preview.jpg` — streams the target's thumbnail with
    a few hours of Cache-Control; gated/without-thumbnail links stream the
    static `logo-full.png` fallback, indistinguishably.
"""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from apps.api.main import app
from apps.api.models.instance_settings import InstanceSettings
from apps.api.routers import share as share_router
from apps.api.routers.share import (
    PREVIEW_FALLBACK_LOGO_PATH,
    PREVIEW_IMAGE_CACHE_SECONDS,
)


_AUTO = object()


@pytest.fixture(autouse=True)
def _query_order(mock_db):
    # Session.query().filter().order_by() remains the same mock query.
    mock_db.order_by.return_value = mock_db



def _link(
    *,
    project_id=_AUTO,
    title="Q3 rollout cut",
    description="Preview cut for the board",
    password_hash=None,
    visibility="public",
    is_enabled=True,
    expires_at=None,
):
    """A lightweight ShareLink stand-in for the gate (no DB round trips needed
    beyond lookups the tests queue explicitly).

    project_id defaults to a fresh uuid so the link resolves as a plain
    project-root share — the branch needing the fewest lookups. Pass None to
    build a link with no target at all."""
    link = MagicMock()
    link.id = uuid.uuid4()
    link.project_id = uuid.uuid4() if project_id is _AUTO else project_id
    link.folder_id = None
    link.asset_id = None
    link.title = title
    link.description = description
    link.password_hash = password_hash
    link.visibility = visibility
    link.is_enabled = is_enabled
    link.expires_at = expires_at
    link.created_by = uuid.uuid4()
    return link


def _queue_first(mock_db, values):
    """Make mock_db.first() yield `values` in order, then None forever.

    Every test documents which lookups the code under test performs, in order;
    anything unexpected after the queue yields None (.rows never exist → the
    gate closes), never stale data leaking into a later branch.
    """
    queue = list(values)

    def _first(*_args, **_kwargs):
        if queue:
            value = queue.pop(0)
            return value
        return None

    mock_db.first.side_effect = _first


# ─── Registration ────────────────────────────────────────────────────────────


def test_preview_endpoints_are_registered():
    paths = set(app.openapi()["paths"])
    assert "/share/{token}/preview" in paths
    assert "/share/{token}/preview.jpg" in paths


# ─── The gate: rich preview ONLY for enabled, unexpired, open links ──────────


@pytest.mark.parametrize(
    "link_factory, case",
    [
        (lambda: _link(password_hash="$2b$12$hash"), "password-protected"),
        (lambda: _link(visibility="secure"), "secure (login required)"),
        (lambda: _link(is_enabled=False), "disabled"),
        (
            lambda: _link(
                expires_at=datetime.now(timezone.utc) - timedelta(hours=1)
            ),
            "expired",
        ),
    ],
)
def test_preview_refuses_every_gated_link_with_one_uniform_404(
    link_factory, case, client, mock_db
):
    """Password / secure / disabled / expired links get the SAME 404 body a
    missing token gets: no state distinction, and no private text anywhere."""
    # A rejecting link stops the gate before target/settings lookups.
    _queue_first(mock_db, [link_factory(), None])

    response = client.get("/share/private-token/preview")

    assert response.status_code == 404, response.text
    assert response.json() == {"detail": "Share link not found"}
    # No link-specific text may leak, not even the title.
    assert "Q3 rollout cut" not in response.text
    assert "Preview cut for the board" not in response.text


@pytest.mark.parametrize(
    "case",
    ["unknown token", "soft-deleted link"],
)
def test_preview_refuses_missing_and_deleted_tokens(case, client, mock_db):
    # (1) ShareLink lookup → nothing stored under this token.
    _queue_first(mock_db, [])

    response = client.get("/share/does-not-exist/preview")

    assert response.status_code == 404, response.text
    assert response.json() == {"detail": "Share link not found"}


@pytest.mark.parametrize("target_kind", ["asset", "folder", "project"])
def test_preview_refuses_link_whose_target_is_gone(target_kind, client, mock_db):
    """A link pointing at a deleted asset behaves like a link that no longer
    exists — not as 404-with-title, not as a 500."""
    link = _link()
    if target_kind != "project":
        setattr(link, f"{target_kind}_id", uuid.uuid4())
    # The link retains project_id even when a more specific target is gone.
    _queue_first(mock_db, [link, None])

    response = client.get("/share/private-token/preview")

    assert response.status_code == 404, response.text
    assert response.json() == {"detail": "Share link not found"}


def test_preview_serves_public_link_title_description_image_flag(client, mock_db):
    # (1) link, (2) existing project, (3) absent settings (default on).
    _queue_first(mock_db, [_link(), MagicMock(), None])
    mock_db.all.return_value = []

    response = client.get("/share/public-token/preview")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body == {
        "title": "Q3 rollout cut",
        "description": "Preview cut for the board",
        "has_image": False,  # resolver found no thumbnail → no +_all items
    }
    assert set(body) == {"title", "description", "has_image"}


def test_preview_title_falls_back_to_project_name(client, mock_db):
    link = _link(title="   ")  # blank → falls back to the target's name
    link.project_id = uuid.uuid4()
    project = MagicMock()
    project.name = "Launch assets"
    _queue_first(mock_db, [link, project, None, project])
    mock_db.all.return_value = []

    body = client.get("/share/public-token/preview").json()
    assert body["title"] == "Launch assets"


# ─── Privacy mechanics ───────────────────────────────────────────────────────


@pytest.mark.parametrize("path", ["/share/open-token/preview", "/share/open-token/preview.jpg"])
def test_preview_never_logs_or_counts_a_share_open(path, client, mock_db):
    """A preview is not a share 'open': no ShareLinkActivity row, no commit."""
    link = _link(project_id=uuid.uuid4())
    _queue_first(mock_db, [link, MagicMock(), None])
    mock_db.all.return_value = []

    client.get(path)

    assert mock_db.add.call_count == 0, "no activity row may be written"
    assert mock_db.commit.call_count == 0


@pytest.fixture
def rate_limit_recorder(monkeypatch):
    """Record every rate-limit action the app enforces; fail open."""
    calls = []

    def _record(ip, action, max_requests, window_seconds):
        calls.append({"ip": ip, "action": action, "max": max_requests, "window": window_seconds})
        return True, 0

    monkeypatch.setattr(
        "apps.api.middleware.rate_limit.check_rate_limit", _record
    )
    return calls


@pytest.mark.parametrize("path", ["/share/open-token/preview", "/share/open-token/preview.jpg"])
def test_preview_uses_its_own_bucket_not_share_validate(
    path, client, mock_db, rate_limit_recorder
):
    """The web server calls the preview from ONE IP; a share_validate-bucketed
    preview would 429 the instance's own unfurls. Ours is a separate, generous
    bucket."""
    link = _link(project_id=uuid.uuid4())
    _queue_first(mock_db, [link, MagicMock(), None])
    mock_db.all.return_value = []

    client.get(path)

    assert len(rate_limit_recorder) == 1
    assert rate_limit_recorder[0]["action"] == "share_preview"
    assert rate_limit_recorder[0]["max"] >= 240  # generous, per the contract


# ─── Toggle: instance-level master switch ────────────────────────────────────


def test_toggle_off_hides_frames_but_keeps_public_text(client, mock_db):
    """Switch off suppresses frames only; public text stays available."""
    link = _link()
    settings_row = MagicMock(spec=InstanceSettings)
    settings_row.share_previews_enabled = False
    # (1) link, (2) existing target, (3) thumbnail switch off.
    _queue_first(mock_db, [link, MagicMock(), settings_row])

    response = client.get("/share/public-token/preview")

    assert response.status_code == 200, response.text
    assert response.json() == {
        "title": "Q3 rollout cut",
        "description": "Preview cut for the board",
        "has_image": False,
    }

    _queue_first(mock_db, [link, MagicMock(), settings_row])
    image = client.get("/share/public-token/preview.jpg")
    # The image endpoint keeps streaming the fallback instead of failing hard.
    assert image.status_code == 200, image.text
    assert image.headers["content-type"] == "image/png"


def test_toggle_missing_row_means_enabled(client, mock_db):
    """No instance_settings row (never configured) → previews stay on, matching
    the storage-limit convention (0 == unlimited)."""
    _queue_first(mock_db, [_link(), MagicMock(), None])
    mock_db.all.return_value = []

    body = client.get("/share/public-token/preview").json()
    assert body["title"] == "Q3 rollout cut"


# ─── The image endpoint ──────────────────────────────────────────────────────


def _logo_bytes():
    return PREVIEW_FALLBACK_LOGO_PATH.read_bytes()


def test_image_streams_fallback_logo_for_unknown_token(client, mock_db):
    _queue_first(mock_db, [])

    response = client.get("/share/who-is-this/preview.jpg")

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/png"
    assert response.headers["cache-control"] == f"public, max-age={PREVIEW_IMAGE_CACHE_SECONDS}"
    assert response.content == _logo_bytes()


def test_image_responses_are_indistinguishable_across_gated_cases(client, mock_db):
    """Password-protected and unknown tokens must stream exactly the same
    fallback bytes — one cannot be told from the other by status, type or body."""
    _queue_first(mock_db, [_link(password_hash="$2b$12$whatever"), None])
    password = client.get("/share/secret-link/preview.jpg")

    _queue_first(mock_db, [])
    unknown = client.get("/share/not-a-token/preview.jpg")

    assert password.status_code == unknown.status_code == 200
    assert password.content == unknown.content == _logo_bytes()
    assert password.headers["cache-control"] == unknown.headers["cache-control"]


def test_image_streams_thumbnail_from_storage(client, mock_db, monkeypatch):
    link = _link(project_id=uuid.uuid4())
    # (1) link, (2) settings → absent; the resolver (isolated below) is stubbed.
    _queue_first(mock_db, [link, MagicMock(), None])
    monkeypatch.setattr(
        share_router, "_resolve_share_thumbnail_key", lambda db, link: "thumbnails/p/asset.webp"
    )

    body_stream = iter([b"FIF", b"0-frame"])
    s3 = MagicMock()
    s3.get_object.return_value = {"Body": body_stream}
    monkeypatch.setattr(share_router, "get_s3_client", lambda: s3)

    response = client.get("/share/public-token/preview.jpg")

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/webp"
    assert response.headers["cache-control"] == f"public, max-age={PREVIEW_IMAGE_CACHE_SECONDS}"
    assert response.content == b"FIF0-frame"
    s3.get_object.assert_called_once_with(
        Bucket=share_router.settings.s3_bucket, Key="thumbnails/p/asset.webp"
    )


def test_image_falls_back_when_storage_hiccups(client, mock_db, monkeypatch):
    link = _link(project_id=uuid.uuid4())
    _queue_first(mock_db, [link, MagicMock(), None])
    monkeypatch.setattr(
        share_router, "_resolve_share_thumbnail_key", lambda db, link: "thumbnails/p/asset.webp"
    )

    s3 = MagicMock()
    s3.get_object.side_effect = RuntimeError("S3 down")
    monkeypatch.setattr(share_router, "get_s3_client", lambda: s3)

    response = client.get("/share/public-token/preview.jpg")

    assert response.status_code == 200, response.text  # not a 500 a unfurl would pin
    assert response.headers["content-type"] == "image/png"
    assert response.content == _logo_bytes()


def test_image_has_no_thumbnail_key_but_still_200_fallback(client, mock_db, monkeypatch):
    link = _link(project_id=uuid.uuid4())
    _queue_first(mock_db, [link, MagicMock(), None])
    monkeypatch.setattr(
        share_router, "_resolve_share_thumbnail_key", lambda db, link: None
    )
    s3 = MagicMock()
    monkeypatch.setattr(share_router, "get_s3_client", lambda: s3)

    response = client.get("/share/public-token/preview.jpg")

    assert response.status_code == 200
    assert response.content == _logo_bytes()
    s3.get_object.assert_not_called()


def test_image_never_leaks_the_presign(client, mock_db, monkeypatch):
    """A key resolving (mocked) to something with a signature must still not
    hand that capability URL to the crawler: the endpoint streams bytes, not
    URLs."""
    link = _link(project_id=uuid.uuid4())
    _queue_first(mock_db, [link, MagicMock(), None])
    monkeypatch.setattr(
        share_router, "_resolve_share_thumbnail_key", lambda db, link: "https://s3.x/obj?sig=1"
    )
    s3 = MagicMock()
    s3.get_object.return_value = {"Body": iter([b"px"])}
    monkeypatch.setattr(share_router, "get_s3_client", lambda: s3)

    response = client.get("/share/public-token/preview.jpg")
    assert b"sig=1" not in response.content
    assert "https://" not in response.text


@pytest.mark.parametrize("target_kind", ["asset", "folder"])
def test_preview_title_uses_specific_target_not_parent_project(target_kind, client, mock_db):
    link = _link(title="")
    setattr(link, f"{target_kind}_id", uuid.uuid4())
    target = MagicMock()
    target.name = "Specific shared target"
    values = [link, target, None, target, None, target] if target_kind == "asset" else [link, target, None, target]
    _queue_first(mock_db, values)
    mock_db.all.return_value = []
    response = client.get("/share/public-token/preview")
    assert response.status_code == 200
    assert response.json()["title"] == "Specific shared target"


@pytest.mark.parametrize("link", [
    _link(password_hash="hash"), _link(visibility="secure"),
    _link(is_enabled=False),
    _link(expires_at=datetime.now(timezone.utc) - timedelta(hours=1)),
    None,
])
def test_image_all_restricted_states_use_same_logo(link, client, mock_db):
    _queue_first(mock_db, [link])
    response = client.get("/share/private-token/preview.jpg")
    assert response.status_code == 200
    assert response.content == _logo_bytes()
    assert response.headers["content-type"] == "image/png"
    assert response.headers["cache-control"] == "public, max-age=10800"


# ─── Thumbnail resolution rules ──────────────────────────────────────────────


def test_resolver_asset_share_uses_latest_ready_version(monkeypatch, mock_db):
    asset_id = uuid.uuid4()
    asset = MagicMock()
    asset.id = asset_id
    mock_db.first.side_effect = lambda *a, **k: asset  # share→asset lookup
    monkeypatch.setattr(
        share_router,
        "_get_latest_media_file",
        lambda db, aid: MagicMock(s3_key_thumbnail="thumbs/asset.png")
        if aid == asset_id
        else None,
    )
    link = _link()
    link.asset_id = asset_id

    assert share_router._resolve_share_thumbnail_key(mock_db, link) == "thumbs/asset.png"

    monkeypatch.setattr(
        share_router, "_get_latest_media_file", lambda db, aid: None
    )
    assert share_router._resolve_share_thumbnail_key(mock_db, link) is None


def test_resolver_folder_share_uses_first_item_even_without_thumbnail(monkeypatch, mock_db):
    first = MagicMock()
    second = MagicMock()
    monkeypatch.setattr(
        share_router, "_folder_assets_with_thumbnails", lambda db, fid: [first, second]
    )
    monkeypatch.setattr(
        share_router,
        "_asset_thumbnail_key",
        lambda db, a: "k/second" if a is second else None,
    )
    link = _link()
    link.folder_id = uuid.uuid4()

    assert share_router._resolve_share_thumbnail_key(mock_db, link) is None


def test_resolver_folder_share_walks_subfolders_when_empty(monkeypatch, mock_db):
    subfolder_asset = MagicMock()
    subfolder = MagicMock()
    subfolder.id = uuid.uuid4()
    mock_db.all.side_effect = lambda *a, **k: [subfolder]

    def _asset_key_for(db, a):
        return "k/sub" if a is subfolder_asset else None

    monkeypatch.setattr(
        share_router, "_asset_thumbnail_key", _asset_key_for
    )

    def _folder_assets(db, fid):
        return [subfolder_asset] if fid == subfolder.id else []

    monkeypatch.setattr(share_router, "_folder_assets_with_thumbnails", _folder_assets)

    link = _link()
    link.folder_id = uuid.uuid4()

    assert share_router._resolve_share_thumbnail_key(mock_db, link) == "k/sub"


def test_resolver_multi_share_walks_selected_items_in_order(monkeypatch, mock_db):
    asset_item = MagicMock()
    asset_item.asset_id = uuid.uuid4()
    folder_item = MagicMock()
    folder_item.asset_id = None
    folder_item.folder_id = uuid.uuid4()
    mock_db.all.side_effect = lambda *a, **k: [asset_item, folder_item]

    item_asset = MagicMock()
    item_asset.id = asset_item.asset_id
    mock_db.first.side_effect = lambda *a, **k: item_asset
    monkeypatch.setattr(
        share_router,
        "_asset_thumbnail_key",
        lambda db, a: "k/item" if a is item_asset else None,
    )

    link = _link()
    link.project_id = uuid.uuid4()

    assert share_router._resolve_share_thumbnail_key(mock_db, link) == "k/item"


def test_resolver_plain_project_root_share_uses_root_assets(monkeypatch, mock_db):
    root_asset = MagicMock()
    mock_db.all.side_effect = lambda *a, **k: [root_asset]
    monkeypatch.setattr(
        share_router, "_asset_thumbnail_key", lambda db, a: "k/root"
    )

    link = _link()
    link.project_id = uuid.uuid4()

    assert share_router._resolve_share_thumbnail_key(mock_db, link) == "k/root"


def test_resolver_returns_none_without_any_item(monkeypatch, mock_db):
    mock_db.all.side_effect = lambda *a, **k: []

    link = _link()
    link.project_id = uuid.uuid4()

    assert share_router._resolve_share_thumbnail_key(mock_db, link) is None
