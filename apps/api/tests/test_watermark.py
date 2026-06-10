"""Watermarking: policy resolution, exemptions, template permissions, and
download gating (burned-in copies for non-exempt viewers)."""
import itertools
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from apps.api.services import watermark_service
from apps.api.schemas.branding import WatermarkRender, WatermarkRenderBlock


def _block(**overrides):
    base = {
        "field": "email", "custom_text": None,
        "x": 50, "y": 50, "size": 4, "color": "#FFFFFF",
        "opacity": 0.35, "rotation": 0, "shadow": False,
        "scroll": False, "tiled": False,
    }
    base.update(overrides)
    return base


def _policy(require_internal=False, require_shares=False, template_id=None,
            exempt_roles=None):
    p = MagicMock()
    p.require_internal = require_internal
    p.require_shares = require_shares
    p.template_id = template_id
    p.exempt_roles = exempt_roles if exempt_roles is not None else ["owner", "editor"]
    return p


def _user(email="viewer@example.com", name="Viewer", superadmin=False):
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = email
    u.name = name
    u.is_superadmin = superadmin
    return u


def _asset():
    a = MagicMock()
    a.id = uuid.uuid4()
    a.project_id = uuid.uuid4()
    return a


# ── Session value rendering ────────────────────────────────────────────────────

def test_render_blocks_substitutes_session_values():
    blocks = [
        _block(field="email"),
        _block(field="name"),
        _block(field="ip"),
        _block(field="date"),
        _block(field="share_name"),
        _block(field="custom_text", custom_text="CONFIDENTIAL"),
    ]
    rendered = watermark_service._render_blocks(
        blocks,
        viewer_name="Ada Lovelace",
        viewer_email="ada@example.com",
        client_ip="203.0.113.7",
        share_name="Rough Cut v2",
    )
    texts = [b.text for b in rendered]
    assert texts[0] == "ada@example.com"
    assert texts[1] == "Ada Lovelace"
    assert texts[2] == "203.0.113.7"
    assert texts[3] == datetime.now(timezone.utc).strftime("%Y-%m-%d")
    assert texts[4] == "Rough Cut v2"
    assert texts[5] == "CONFIDENTIAL"


def test_render_blocks_drops_empty_fields():
    blocks = [_block(field="ip"), _block(field="custom_text", custom_text="X")]
    rendered = watermark_service._render_blocks(
        blocks, viewer_name=None, viewer_email=None, client_ip=None, share_name=None
    )
    assert [b.text for b in rendered] == ["X"]


# ── Internal viewer resolution ─────────────────────────────────────────────────

def test_internal_disabled_when_no_policy():
    with patch.object(watermark_service, "get_effective_policy", return_value=None):
        result = watermark_service.resolve_internal_watermark(MagicMock(), _asset(), _user())
    assert result.enabled is False


def test_internal_disabled_when_policy_off():
    policy = _policy(require_internal=False)
    with patch.object(watermark_service, "get_effective_policy", return_value=policy):
        result = watermark_service.resolve_internal_watermark(MagicMock(), _asset(), _user())
    assert result.enabled is False


def test_internal_exempt_role_sees_no_watermark():
    policy = _policy(require_internal=True, exempt_roles=["owner", "editor"])
    member = MagicMock()
    member.role.value = "editor"
    with patch.object(watermark_service, "get_effective_policy", return_value=policy), \
         patch.object(watermark_service, "get_project_member", return_value=member):
        result = watermark_service.resolve_internal_watermark(MagicMock(), _asset(), _user())
    assert result.enabled is False


def test_internal_superadmin_exempt():
    policy = _policy(require_internal=True, exempt_roles=[])
    with patch.object(watermark_service, "get_effective_policy", return_value=policy), \
         patch.object(watermark_service, "get_project_member", return_value=None):
        result = watermark_service.resolve_internal_watermark(
            MagicMock(), _asset(), _user(superadmin=True)
        )
    assert result.enabled is False


def test_internal_non_exempt_viewer_gets_watermark():
    policy = _policy(require_internal=True, exempt_roles=["owner"])
    member = MagicMock()
    member.role.value = "viewer"
    with patch.object(watermark_service, "get_effective_policy", return_value=policy), \
         patch.object(watermark_service, "get_project_member", return_value=member), \
         patch.object(watermark_service, "get_instance_policy", return_value=None), \
         patch.object(watermark_service, "get_template", return_value=None):
        result = watermark_service.resolve_internal_watermark(
            MagicMock(), _asset(), _user(email="crew@example.com"), client_ip="10.0.0.5"
        )
    assert result.enabled is True
    # Fallback template is a single email block
    assert result.blocks[0].text == "crew@example.com"


# ── Share viewer resolution ────────────────────────────────────────────────────

def test_share_disabled_when_toggle_off_and_not_required():
    link = MagicMock()
    link.show_watermark = False
    with patch.object(watermark_service, "get_effective_policy", return_value=None):
        result = watermark_service.resolve_share_watermark(MagicMock(), _asset(), link)
    assert result.enabled is False


def test_share_policy_forces_watermark_even_when_toggle_off():
    link = MagicMock()
    link.show_watermark = False
    link.watermark_template_id = None
    link.title = "Client Review"
    link.created_by = uuid.uuid4()

    policy = _policy(require_shares=True)
    creator = MagicMock()
    creator.email = "owner@example.com"
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.first.return_value = creator  # share creator lookup (anonymous viewer)

    with patch.object(watermark_service, "get_effective_policy", return_value=policy), \
         patch.object(watermark_service, "get_instance_policy", return_value=None), \
         patch.object(watermark_service, "get_template", return_value=None):
        result = watermark_service.resolve_share_watermark(db, _asset(), link)
    assert result.enabled is True


def test_share_anonymous_viewer_falls_back_to_share_identity():
    """Anonymous viewers get the share title / creator email in place of
    name/email, matching Frame.io behavior."""
    link = MagicMock()
    link.show_watermark = True
    link.watermark_template_id = None
    link.title = "Press Screener"
    link.created_by = uuid.uuid4()

    creator = MagicMock()
    creator.email = "producer@example.com"
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.first.return_value = creator

    template = MagicMock()
    template.blocks = [_block(field="name"), _block(field="email")]

    with patch.object(watermark_service, "get_effective_policy", return_value=None), \
         patch.object(watermark_service, "get_instance_policy", return_value=None), \
         patch.object(watermark_service, "get_template", return_value=template):
        result = watermark_service.resolve_share_watermark(db, _asset(), link, user=None)

    texts = [b.text for b in result.blocks]
    assert texts == ["Press Screener", "producer@example.com"]


def test_share_template_priority_share_over_project_over_instance():
    """The share-level template wins over project and instance templates."""
    share_tid = uuid.uuid4()
    project_tid = uuid.uuid4()

    link = MagicMock()
    link.show_watermark = True
    link.watermark_template_id = share_tid
    link.title = "T"
    link.created_by = uuid.uuid4()

    share_template = MagicMock()
    share_template.blocks = [_block(field="custom_text", custom_text="SHARE")]

    seen_ids = []

    def fake_get_template(db, tid):
        seen_ids.append(tid)
        return share_template if tid == share_tid else None

    policy = _policy(require_shares=False, template_id=project_tid)
    with patch.object(watermark_service, "get_effective_policy", return_value=policy), \
         patch.object(watermark_service, "get_instance_policy", return_value=None), \
         patch.object(watermark_service, "get_template", side_effect=fake_get_template):
        result = watermark_service.resolve_share_watermark(
            MagicMock(), _asset(), link, user=_user()
        )

    assert result.blocks[0].text == "SHARE"
    assert seen_ids[0] == share_tid  # checked first


# ── Cache signature ────────────────────────────────────────────────────────────

def _render(text="a@b.c"):
    return WatermarkRender(enabled=True, blocks=[
        WatermarkRenderBlock(
            text=text, x=50, y=50, size=4, color="#FFFFFF",
            opacity=0.35, rotation=0, shadow=False, scroll=False, tiled=False,
        )
    ])


def test_signature_stable_for_same_render():
    assert watermark_service.watermark_signature(_render()) == \
        watermark_service.watermark_signature(_render())


def test_signature_changes_with_content():
    assert watermark_service.watermark_signature(_render("a@b.c")) != \
        watermark_service.watermark_signature(_render("x@y.z"))


# ── FFmpeg filter construction ─────────────────────────────────────────────────

def test_filter_basic_block():
    from apps.api.tasks.watermark_tasks import build_watermark_filter

    blocks = [{"text": "user@example.com", "x": 50, "y": 50, "size": 4,
               "color": "#FFFFFF", "opacity": 0.35, "rotation": 0,
               "shadow": False, "scroll": False, "tiled": False}]
    f = build_watermark_filter(blocks, 1920, 1080, is_video=True)
    assert "drawtext=" in f
    assert "text='user@example.com'" in f
    assert "[vout]" in f
    assert "rotate=" not in f


def test_filter_rotation_tiling_and_scroll():
    from apps.api.tasks.watermark_tasks import build_watermark_filter, TILE_POSITIONS

    blocks = [{"text": "X", "x": 50, "y": 50, "size": 4, "color": "#FFFFFF",
               "opacity": 0.5, "rotation": -30, "shadow": True,
               "scroll": True, "tiled": True}]
    f = build_watermark_filter(blocks, 1280, 720, is_video=True)
    assert f.count("drawtext=") == len(TILE_POSITIONS)
    assert "rotate=-30.0*PI/180" in f
    assert "shadowcolor=" in f
    assert "mod(t*" in f  # scroll expression

    # Scrolling is a video-only effect — stills get a static overlay
    f_img = build_watermark_filter(blocks, 1280, 720, is_video=False)
    assert "mod(t*" not in f_img


def test_filter_escapes_quotes():
    from apps.api.tasks.watermark_tasks import build_watermark_filter

    blocks = [{"text": "it's confidential", "x": 50, "y": 50, "size": 4,
               "color": "#FFFFFF", "opacity": 0.35, "rotation": 0,
               "shadow": False, "scroll": False, "tiled": False}]
    f = build_watermark_filter(blocks, 1920, 1080, is_video=True)
    assert "it's" not in f  # raw single quote would break the filter string


# ── Template CRUD permissions ──────────────────────────────────────────────────

def test_instance_template_create_requires_superadmin(client, auth_headers):
    response = client.post(
        "/watermark-templates",
        json={"name": "T", "blocks": [_block()]},
        headers=auth_headers,
    )
    assert response.status_code == 403


def test_instance_policy_requires_superadmin(client, auth_headers):
    assert client.get("/settings/watermark", headers=auth_headers).status_code == 403
    assert client.put(
        "/settings/watermark", json={"require_shares": True}, headers=auth_headers
    ).status_code == 403


def test_instance_template_update_requires_superadmin(client, mock_db, auth_headers):
    from apps.api.models.branding import WatermarkTemplateScope

    template = MagicMock()
    template.scope = WatermarkTemplateScope.instance
    mock_db.first.return_value = template

    response = client.patch(
        f"/watermark-templates/{uuid.uuid4()}",
        json={"name": "Renamed"},
        headers=auth_headers,
    )
    assert response.status_code == 403


def test_project_template_create_requires_editor(client, auth_headers):
    with patch("apps.api.routers.branding.require_project_role") as mock_role:
        from fastapi import HTTPException
        mock_role.side_effect = HTTPException(status_code=403, detail="Forbidden")
        response = client.post(
            f"/projects/{uuid.uuid4()}/watermark-templates",
            json={"name": "T", "blocks": [_block()]},
            headers=auth_headers,
        )
    assert response.status_code == 403


# ── Download gating (202 while the burn-in renders) ────────────────────────────

def _setup_asset_chain(mock_db, asset_type):
    from apps.api.models.asset import ProcessingStatus

    mock_db.order_by.return_value = mock_db

    asset = MagicMock()
    asset.id = uuid.uuid4()
    asset.project_id = uuid.uuid4()
    asset.asset_type = asset_type
    asset.name = "demo"
    asset.deleted_at = None

    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = asset.id
    version.processing_status = ProcessingStatus.ready
    version.deleted_at = None

    media_file = MagicMock()
    media_file.version_id = version.id
    media_file.s3_key_processed = "processed/p/v"
    media_file.s3_key_raw = "raw/p/v/input.mp4"
    media_file.original_filename = "input.mp4"

    mock_db.first.side_effect = itertools.chain(
        [asset, version, media_file], itertools.repeat(None)
    )
    return asset


@patch("apps.api.routers.assets.require_asset_access")
def test_watermarked_download_returns_202_while_preparing(
    mock_access, client, mock_db, auth_headers
):
    from apps.api.models.asset import AssetType

    asset = _setup_asset_chain(mock_db, AssetType.video)
    mock_access.return_value = None

    with patch.object(
        watermark_service, "resolve_internal_watermark", return_value=_render()
    ), patch.object(
        watermark_service, "get_or_request_watermarked_download", return_value=None
    ) as mock_request:
        response = client.get(
            f"/assets/{asset.id}/stream?download=true", headers=auth_headers
        )

    assert response.status_code == 202
    assert response.json()["status"] == "preparing"
    mock_request.assert_called_once()


@patch("apps.api.routers.assets.require_asset_access")
def test_watermarked_download_returns_cached_url_when_ready(
    mock_access, client, mock_db, auth_headers
):
    from apps.api.models.asset import AssetType

    asset = _setup_asset_chain(mock_db, AssetType.video)
    mock_access.return_value = None

    with patch.object(
        watermark_service, "resolve_internal_watermark", return_value=_render()
    ), patch.object(
        watermark_service,
        "get_or_request_watermarked_download",
        return_value="https://s3.example.com/watermarked.mp4?sig=x",
    ):
        response = client.get(
            f"/assets/{asset.id}/stream?download=true", headers=auth_headers
        )

    assert response.status_code == 200
    assert response.json()["url"] == "https://s3.example.com/watermarked.mp4?sig=x"


@patch("apps.api.routers.assets.generate_presigned_get_url")
@patch("apps.api.routers.assets.require_asset_access")
def test_exempt_download_gets_clean_original(
    mock_access, mock_presign, client, mock_db, auth_headers
):
    from apps.api.models.asset import AssetType

    asset = _setup_asset_chain(mock_db, AssetType.video)
    mock_access.return_value = None
    mock_presign.return_value = "https://s3.example.com/raw.mp4?sig=x"

    with patch.object(
        watermark_service,
        "resolve_internal_watermark",
        return_value=WatermarkRender(enabled=False, blocks=[]),
    ), patch.object(
        watermark_service, "get_or_request_watermarked_download"
    ) as mock_request:
        response = client.get(
            f"/assets/{asset.id}/stream?download=true", headers=auth_headers
        )

    assert response.status_code == 200
    assert response.json()["url"] == "https://s3.example.com/raw.mp4?sig=x"
    mock_request.assert_not_called()


@patch("apps.api.routers.assets.require_asset_access")
def test_stream_payload_carries_watermark_blocks(
    mock_access, client, mock_db, auth_headers
):
    """Playback responses include resolved blocks so the client overlay can
    render without making policy decisions."""
    from apps.api.models.asset import AssetType

    asset = _setup_asset_chain(mock_db, AssetType.video)
    mock_access.return_value = None

    with patch.object(
        watermark_service, "resolve_internal_watermark", return_value=_render("wm@x.io")
    ):
        response = client.get(f"/assets/{asset.id}/stream", headers=auth_headers)

    assert response.status_code == 200
    wm = response.json()["watermark"]
    assert wm["enabled"] is True
    assert wm["blocks"][0]["text"] == "wm@x.io"
