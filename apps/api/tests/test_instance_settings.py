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


def test_get_settings_member(client, auth_headers, mock_db, test_user, monkeypatch):
    test_user.is_superadmin = False
    mock_db.first.return_value = MagicMock(storage_limit_bytes=8000)
    monkeypatch.setattr(storage_service, "instance_storage_used_bytes", lambda db: 100)
    r = client.get("/instance/settings", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == {"storage_limit_bytes": 8000, "storage_used_bytes": 100}
