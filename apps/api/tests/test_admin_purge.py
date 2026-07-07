"""Tests for the manual superadmin purge endpoint (#65)."""
import apps.api.routers.admin as admin_module
from apps.api.tasks.cleanup_tasks import PurgeCounts


def test_purge_requires_superadmin(client, auth_headers, mock_db, test_user):
    test_user.is_superadmin = False
    resp = client.post("/admin/purge", headers=auth_headers)
    assert resp.status_code == 403


def test_purge_returns_counts_for_superadmin(client, auth_headers, mock_db, test_user, monkeypatch):
    test_user.is_superadmin = True
    fake = PurgeCounts(retention_days=30, projects=2, assets=5, versions=7, media_files=7,
                       comments=3, share_links=1, share_links_expired=4, s3_deletes=20)
    monkeypatch.setattr(admin_module, "_run_cleanup", lambda db: fake)

    resp = client.post("/admin/purge", headers=auth_headers)

    assert resp.status_code == 200
    body = resp.json()
    assert body["retention_days"] == 30
    assert body["projects"] == 2
    assert body["share_links_expired"] == 4
