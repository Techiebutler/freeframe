"""Tests for the manual superadmin purge endpoint (#65)."""
import apps.api.routers.admin as admin_module


def test_purge_requires_superadmin(client, auth_headers, mock_db, test_user):
    test_user.is_superadmin = False
    resp = client.post("/admin/purge", headers=auth_headers)
    assert resp.status_code == 403


def test_purge_enqueues_task_for_superadmin(client, auth_headers, mock_db, test_user, monkeypatch):
    test_user.is_superadmin = True
    calls = []
    monkeypatch.setattr(admin_module, "send_task_safe", lambda task, *a, **k: calls.append(task))

    resp = client.post("/admin/purge", headers=auth_headers)

    assert resp.status_code == 202
    assert resp.json()["status"] == "started"
    assert admin_module.cleanup_soft_deleted in calls
