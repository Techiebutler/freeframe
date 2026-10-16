"""Tests for instance_settings model, storage service, router, and cap enforcement."""
from apps.api.models.instance_settings import InstanceSettings


def test_instance_settings_table_shape():
    cols = InstanceSettings.__table__.columns
    assert InstanceSettings.__tablename__ == "instance_settings"
    assert "storage_limit_bytes" in cols
    # 0 = unlimited default
    assert cols["storage_limit_bytes"].server_default.arg == "0"
    assert cols["storage_limit_bytes"].nullable is False


from unittest.mock import MagicMock
from apps.api.services import storage as storage_service


def test_get_storage_limit_no_row_is_unlimited(mock_db):
    mock_db.first.return_value = None
    assert storage_service.get_storage_limit(mock_db) == 0


def test_get_storage_limit_reads_row(mock_db):
    mock_db.first.return_value = MagicMock(storage_limit_bytes=5_000)
    assert storage_service.get_storage_limit(mock_db) == 5_000


def test_storage_cap_error_unlimited_returns_none(mock_db, monkeypatch):
    monkeypatch.setattr(storage_service, "get_storage_limit", lambda db: 0)
    # usage must not even be queried when unlimited
    monkeypatch.setattr(storage_service, "instance_storage_used_bytes",
                        lambda db: (_ for _ in ()).throw(AssertionError("should not run")))
    assert storage_service.storage_cap_error(mock_db, 10_000) is None


def test_storage_cap_error_under_limit_returns_none(mock_db, monkeypatch):
    monkeypatch.setattr(storage_service, "get_storage_limit", lambda db: 1_000)
    monkeypatch.setattr(storage_service, "instance_storage_used_bytes", lambda db: 400)
    assert storage_service.storage_cap_error(mock_db, 500) is None       # 900 <= 1000


def test_storage_cap_error_at_limit_returns_none(mock_db, monkeypatch):
    monkeypatch.setattr(storage_service, "get_storage_limit", lambda db: 1_000)
    monkeypatch.setattr(storage_service, "instance_storage_used_bytes", lambda db: 600)
    assert storage_service.storage_cap_error(mock_db, 400) is None       # exactly 1000, not over


def test_storage_cap_error_over_limit_returns_message(mock_db, monkeypatch):
    monkeypatch.setattr(storage_service, "get_storage_limit", lambda db: 1_000)
    monkeypatch.setattr(storage_service, "instance_storage_used_bytes", lambda db: 800)
    err = storage_service.storage_cap_error(mock_db, 400)               # 1200 > 1000
    assert err is not None
    assert "Storage limit reached" in err


def test_upload_guard_error_size_wins(mock_db, monkeypatch):
    monkeypatch.setattr(storage_service, "upload_size_error", lambda n: "too big")
    monkeypatch.setattr(storage_service, "storage_cap_error", lambda db, n: "cap!")
    assert storage_service.upload_guard_error(mock_db, 123) == "too big"   # per-file checked first


def test_upload_guard_error_falls_through_to_cap(mock_db, monkeypatch):
    monkeypatch.setattr(storage_service, "upload_size_error", lambda n: None)
    monkeypatch.setattr(storage_service, "storage_cap_error", lambda db, n: "cap!")
    assert storage_service.upload_guard_error(mock_db, 123) == "cap!"


def test_upload_guard_error_both_pass(mock_db, monkeypatch):
    monkeypatch.setattr(storage_service, "upload_size_error", lambda n: None)
    monkeypatch.setattr(storage_service, "storage_cap_error", lambda db, n: None)
    assert storage_service.upload_guard_error(mock_db, 123) is None


from apps.api.services import storage as storage_service


def test_put_settings_requires_admin(client, auth_headers, mock_db, test_user):
    test_user.is_superadmin = False
    r = client.put("/instance/settings", headers=auth_headers, json={"storage_limit_bytes": 1000})
    assert r.status_code == 403


def test_put_settings_admin_updates(client, auth_headers, mock_db, test_user, monkeypatch):
    test_user.is_superadmin = True
    mock_db.first.return_value = None                     # get_or_create → creates row
    monkeypatch.setattr(storage_service, "instance_storage_used_bytes", lambda db: 42)

    def _refresh(obj):
        obj.storage_limit_bytes = getattr(obj, "storage_limit_bytes", 0)
    mock_db.refresh.side_effect = _refresh

    r = client.put("/instance/settings", headers=auth_headers, json={"storage_limit_bytes": 9000})
    assert r.status_code == 200
    body = r.json()
    assert body["storage_limit_bytes"] == 9000
    assert body["storage_used_bytes"] == 42


def test_put_settings_rejects_negative(client, auth_headers, mock_db, test_user):
    test_user.is_superadmin = True
    r = client.put("/instance/settings", headers=auth_headers, json={"storage_limit_bytes": -1})
    assert r.status_code == 422


def test_put_settings_rejects_over_bigint_max(client, auth_headers, mock_db, test_user):
    test_user.is_superadmin = True
    # 2**63 exceeds PostgreSQL BigInteger; reject at validation (422), never overflow into a 500.
    r = client.put("/instance/settings", headers=auth_headers, json={"storage_limit_bytes": 9223372036854775808})
    assert r.status_code == 422


def test_get_settings_member(client, auth_headers, mock_db, test_user, monkeypatch):
    test_user.is_superadmin = False
    mock_db.first.return_value = MagicMock(storage_limit_bytes=8000)
    monkeypatch.setattr(storage_service, "instance_storage_used_bytes", lambda db: 100)
    r = client.get("/instance/settings", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == {"storage_limit_bytes": 8000, "storage_used_bytes": 100, "share_previews_enabled": True}


def test_get_settings_no_row_is_read_only_and_unlimited(client, auth_headers, mock_db, test_user, monkeypatch):
    # No row exists yet — GET must NOT create one; it should default to unlimited (0).
    test_user.is_superadmin = False
    mock_db.first.return_value = None
    monkeypatch.setattr(storage_service, "instance_storage_used_bytes", lambda db: 100)
    r = client.get("/instance/settings", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == {"storage_limit_bytes": 0, "storage_used_bytes": 100, "share_previews_enabled": True}
    mock_db.add.assert_not_called()
    mock_db.commit.assert_not_called()


import uuid
from apps.api.routers import upload as upload_router


def test_initiate_upload_rejected_when_over_cap(client, auth_headers, mock_db, test_user, monkeypatch):
    # Force the upload guard to trip regardless of DB state
    monkeypatch.setattr(upload_router, "upload_guard_error", lambda db, n: "Storage limit reached — 9 GB of 10 GB used")
    body = {
        "project_id": str(uuid.uuid4()),
        "asset_name": "big.mp4",
        "original_filename": "big.mp4",
        "mime_type": "video/mp4",
        "file_size_bytes": 2_000_000_000,
    }
    r = client.post("/upload/initiate", headers=auth_headers, json=body)
    assert r.status_code == 400
    assert "Storage limit reached" in r.json()["detail"]


def test_initiate_upload_allowed_when_guard_passes(client, auth_headers, mock_db, test_user, monkeypatch):
    # guard returns None; expect to pass the gate and fail later on project lookup (404)
    # — proving the guard did NOT block it.
    monkeypatch.setattr(upload_router, "upload_guard_error", lambda db, n: None)
    monkeypatch.setattr(upload_router, "choose_part_size", lambda db, n: (10 * 1024 * 1024, None))
    mock_db.first.return_value = None                    # project not found → 404 after the gate
    body = {
        "project_id": str(uuid.uuid4()),
        "asset_name": "ok.mp4",
        "original_filename": "ok.mp4",
        "mime_type": "video/mp4",
        "file_size_bytes": 1_000,
    }
    r = client.post("/upload/initiate", headers=auth_headers, json=body)
    assert r.status_code == 404                          # got past the guard gate



# ── allow_original_downloads ────────────────────────────────────────────────
# Off by default: before there was a choice, people outside a project could only
# download the transcode, and an upgrade must not change that on its own.

def test_original_downloads_are_off_by_default():
    col = InstanceSettings.__table__.columns["allow_original_downloads"]
    assert col.server_default.arg == "false"
    assert col.nullable is False


def test_admin_can_turn_original_downloads_on(client, auth_headers, mock_db, test_user, monkeypatch):
    test_user.is_superadmin = True
    row = MagicMock(storage_limit_bytes=0, upload_part_size_bytes=0, allow_original_downloads=False)
    mock_db.first.return_value = row
    monkeypatch.setattr(storage_service, "instance_storage_used_bytes", lambda db: 0)

    r = client.put("/instance/settings", headers=auth_headers, json={"allow_original_downloads": True})

    assert r.status_code == 200, r.text
    assert row.allow_original_downloads is True
    assert r.json()["allow_original_downloads"] is True
    assert storage_service.get_allow_original_downloads(mock_db) is True


def test_a_member_cannot_change_or_see_original_downloads(
    client, auth_headers, mock_db, test_user, monkeypatch,
):
    mock_db.first.return_value = MagicMock(
        storage_limit_bytes=0, upload_part_size_bytes=0, allow_original_downloads=True,
    )
    monkeypatch.setattr(storage_service, "instance_storage_used_bytes", lambda db: 0)
    test_user.is_superadmin = False

    assert client.put(
        "/instance/settings", headers=auth_headers, json={"allow_original_downloads": False}
    ).status_code == 403
    assert "allow_original_downloads" not in client.get(
        "/instance/settings", headers=auth_headers).json()


# ─── Share-preview master switch (share_previews_enabled) ────────────────────


def test_instance_settings_share_previews_column_shape():
    cols = InstanceSettings.__table__.columns
    assert "share_previews_enabled" in cols
    assert cols["share_previews_enabled"].server_default.arg == "true"
    assert cols["share_previews_enabled"].nullable is False


def test_put_settings_admin_updates_share_previews_toggle(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    test_user.is_superadmin = True
    mock_db.first.return_value = None                    # get_or_create → creates row
    monkeypatch.setattr(storage_service, "instance_storage_used_bytes", lambda db: 3)

    def _refresh(obj):
        if obj.storage_limit_bytes is None:
            obj.storage_limit_bytes = 0
        if obj.share_previews_enabled is None:
            obj.share_previews_enabled = True
    mock_db.refresh.side_effect = _refresh

    r = client.put(
        "/instance/settings", headers=auth_headers, json={"share_previews_enabled": False}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["share_previews_enabled"] is False


def test_put_settings_does_not_touch_toggle_when_absent(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    """PUT without the `share_previews_enabled` key must leave the toggle as is."""
    test_user.is_superadmin = True
    existing = MagicMock(storage_limit_bytes=0, share_previews_enabled=True)
    mock_db.first.return_value = existing                # get_or_create → existing row
    monkeypatch.setattr(storage_service, "instance_storage_used_bytes", lambda db: 3)

    r = client.put(
        "/instance/settings", headers=auth_headers, json={"storage_limit_bytes": 5000}
    )
    assert r.status_code == 200, r.text
    assert existing.share_previews_enabled is True       # unchanged
    assert r.json()["share_previews_enabled"] is True


def test_instance_settings_response_defaults_to_enabled():
    from apps.api.schemas.instance_settings import InstanceSettingsResponse

    r = InstanceSettingsResponse(storage_limit_bytes=0, storage_used_bytes=0)
    assert r.share_previews_enabled is True

