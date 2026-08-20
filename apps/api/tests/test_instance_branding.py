"""Tests for instance branding — logo upload, CRUD, and presigned URL generation."""
import uuid
from datetime import datetime, timezone
import pytest
from unittest.mock import patch, MagicMock

from apps.api.models.instance_branding import InstanceBranding


# ── GET /instance/branding ──────────────────────────────────────────────

def test_get_branding_returns_defaults(client, mock_db):
    mock_db.first.return_value = None  # no row yet → auto-create

    with patch(
        "apps.api.routers.instance_branding.s3_service.generate_presigned_get_url",
        return_value="https://example.com/presigned-get",
    ):
        r = client.get("/instance/branding")
    assert r.status_code == 200
    body = r.json()
    assert "org_name" in body
    assert "powered_by_freeframe" in body


# ── PUT /instance/branding ──────────────────────────────────────────────

def test_put_branding_requires_admin(client, auth_headers, mock_db, test_user):
    test_user.is_superadmin = False
    r = client.put("/instance/branding", headers=auth_headers, json={"org_name": "Acme"})
    assert r.status_code == 403


def test_put_branding_updates_fields(client, auth_headers, mock_db, test_user):
    test_user.is_superadmin = True
    mock_db.first.return_value = None

    with patch(
        "apps.api.routers.instance_branding.s3_service.generate_presigned_get_url",
        return_value="https://example.com/presigned-get",
    ):
        r = client.put(
            "/instance/branding",
            headers=auth_headers,
            json={"org_name": "Acme", "powered_by_freeframe": False},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["org_name"] == "Acme"
    assert body["powered_by_freeframe"] is False


def test_put_branding_null_logo_key_deletes_old_object(client, auth_headers, mock_db, test_user, monkeypatch):
    """Clearing a logo key with an explicit null must delete the old S3 object."""
    test_user.is_superadmin = True

    now = datetime.now(timezone.utc)
    branding = InstanceBranding(
        id=uuid.uuid4(),
        org_name="FreeFrame",
        powered_by_freeframe=True,
        created_at=now,
        updated_at=now,
    )
    branding.logo_light_key = "branding/logo-light/old-key"
    mock_db.first.return_value = branding

    delete_calls = []
    monkeypatch.setattr(
        "apps.api.routers.instance_branding.s3_service.delete_object",
        lambda key: delete_calls.append(key),
    )

    with patch(
        "apps.api.routers.instance_branding.s3_service.generate_presigned_get_url",
        return_value="https://example.com/presigned-get",
    ):
        r = client.put(
            "/instance/branding",
            headers=auth_headers,
            json={"logo_light_key": None},
        )
    assert r.status_code == 200
    assert delete_calls == ["branding/logo-light/old-key"]
    assert branding.logo_light_key is None


# ── POST /instance/branding/{logo_type}-upload ──────────────────────────

def test_upload_presign_requires_admin(client, auth_headers, mock_db, test_user):
    test_user.is_superadmin = False
    r = client.post(
        "/instance/branding/logo-light-upload",
        headers=auth_headers,
        params={"content_type": "image/png"},
    )
    assert r.status_code == 403


def test_upload_presign_rejects_invalid_logo_type(client, auth_headers, mock_db, test_user):
    test_user.is_superadmin = True
    r = client.post(
        "/instance/branding/banana-upload",
        headers=auth_headers,
        params={"content_type": "image/png"},
    )
    assert r.status_code == 400
    assert "Invalid logo type" in r.json()["detail"]


def test_upload_presign_uses_generate_presigned_put_url(client, auth_headers, mock_db, test_user, monkeypatch):
    """The endpoint must call generate_presigned_put_url (public endpoint), not raw S3 client."""
    test_user.is_superadmin = True

    calls = []

    def fake_put_url(key, content_type=None, expires_in=3600):
        calls.append({"key": key, "content_type": content_type, "expires_in": expires_in})
        return f"https://public.example.com/put/{key}"

    monkeypatch.setattr(
        "apps.api.routers.instance_branding.s3_service.generate_presigned_put_url",
        fake_put_url,
    )

    r = client.post(
        "/instance/branding/logo-light-upload",
        headers=auth_headers,
        params={"content_type": "image/png"},
    )
    assert r.status_code == 201
    body = r.json()
    assert body["upload_url"].startswith("https://public.example.com/put/")
    assert body["key"].startswith("branding/logo-light/")

    assert len(calls) == 1
    assert calls[0]["content_type"] == "image/png"
    assert calls[0]["expires_in"] == 3600


def test_upload_presign_passes_client_content_type(client, auth_headers, mock_db, test_user, monkeypatch):
    """When the frontend provides ?content_type=, it must be forwarded — not overridden by the slot default."""
    test_user.is_superadmin = True

    received = {}

    def fake_put_url(key, content_type=None, expires_in=3600):
        received["content_type"] = content_type
        return "https://example.com/put"

    monkeypatch.setattr(
        "apps.api.routers.instance_branding.s3_service.generate_presigned_put_url",
        fake_put_url,
    )

    # the favicon slot used to be hardcoded to "image/x-icon"
    r = client.post(
        "/instance/branding/favicon-upload",
        headers=auth_headers,
        params={"content_type": "image/svg+xml"},
    )
    assert r.status_code == 201
    assert received["content_type"] == "image/svg+xml", (
        "Client-supplied content_type must take precedence; the old code "
        "hardcoded 'image/x-icon' for favicon which would mismatch an SVG upload."
    )


def test_upload_presign_without_content_type_leaves_it_unsigned(client, auth_headers, mock_db, test_user, monkeypatch):
    """When no ?content_type= is provided, ContentType must NOT be signed — S3 won't validate it."""
    test_user.is_superadmin = True

    received = {}

    def fake_put_url(key, content_type=None, expires_in=3600):
        received["content_type"] = content_type
        return "https://example.com/put"

    monkeypatch.setattr(
        "apps.api.routers.instance_branding.s3_service.generate_presigned_put_url",
        fake_put_url,
    )

    r = client.post(
        "/instance/branding/logo-light-upload",
        headers=auth_headers,
        # No content_type query param at all
    )
    assert r.status_code == 201
    assert received["content_type"] is None, (
        "Without a content_type query param, the presigned URL must not pin a ContentType. "
        "The old code hardcoded 'image/webp' which mismatches PNG/SVG uploads and S3 403s."
    )


def test_upload_presign_key_prefix_matches_logo_type(client, auth_headers, mock_db, test_user, monkeypatch):
    """Each slot must use its own key prefix so uploads don't collide."""
    test_user.is_superadmin = True
    received_keys = []

    def fake_put_url(key, content_type=None, expires_in=3600):
        received_keys.append(key)
        return "https://example.com/put"

    monkeypatch.setattr(
        "apps.api.routers.instance_branding.s3_service.generate_presigned_put_url",
        fake_put_url,
    )

    for slot in ["logo-dark", "apple-icon", "login-logo"]:
        r = client.post(
            f"/instance/branding/{slot}-upload",
            headers=auth_headers,
        )
        assert r.status_code == 201

    assert any(k.startswith("branding/logo-dark/") for k in received_keys)
    assert any(k.startswith("branding/apple-icon/") for k in received_keys)
    assert any(k.startswith("branding/login-logo/") for k in received_keys)


# ── DELETE /instance/branding/logo/{logo_type} ──────────────────────────

def test_delete_logo_requires_admin(client, auth_headers, mock_db, test_user):
    test_user.is_superadmin = False
    r = client.delete("/instance/branding/logo/logo-light", headers=auth_headers)
    assert r.status_code == 403


def test_delete_logo_invalid_type(client, auth_headers, mock_db, test_user):
    test_user.is_superadmin = True
    r = client.delete("/instance/branding/logo/banana", headers=auth_headers)
    assert r.status_code == 400


def test_delete_logo_clears_key_and_deletes_object(client, auth_headers, mock_db, test_user, monkeypatch):
    test_user.is_superadmin = True

    now = datetime.now(timezone.utc)
    branding = InstanceBranding(
        id=uuid.uuid4(),
        org_name="FreeFrame",
        powered_by_freeframe=True,
        created_at=now,
        updated_at=now,
    )
    branding.logo_light_key = "branding/logo-light/old-key"
    branding.logo_dark_key = None
    branding.favicon_key = None
    branding.apple_icon_key = None
    branding.login_logo_key = None
    mock_db.first.return_value = branding

    delete_calls = []
    monkeypatch.setattr(
        "apps.api.routers.instance_branding.s3_service.delete_object",
        lambda key: delete_calls.append(key),
    )

    with patch(
        "apps.api.routers.instance_branding.s3_service.generate_presigned_get_url",
        return_value="https://example.com/presigned-get",
    ):
        r = client.delete("/instance/branding/logo/logo-light", headers=auth_headers)

    assert r.status_code == 200
    assert delete_calls == ["branding/logo-light/old-key"]
    assert branding.logo_light_key is None
    mock_db.commit.assert_called_once()
