"""Tests for the configurable per-file upload size limit (issue #64).

The 10 GB per-file cap used to be hardcoded. It is now driven by
`settings.max_upload_bytes`, where 0 means unlimited (no per-file cap).
"""
from apps.api.config import settings
from apps.api.schemas.upload import upload_size_error


def test_unlimited_when_zero(monkeypatch):
    """max_upload_bytes == 0 disables the cap — no error even for huge files."""
    monkeypatch.setattr(settings, "max_upload_bytes", 0)
    assert upload_size_error(50 * 1024 * 1024 * 1024) is None  # 50 GB


def test_rejects_file_over_limit(monkeypatch):
    monkeypatch.setattr(settings, "max_upload_bytes", 2 * 1024 * 1024 * 1024)  # 2 GB cap
    err = upload_size_error(3 * 1024 * 1024 * 1024)  # 3 GB
    assert err is not None
    assert "2 GB" in err  # message reports the configured cap, not a hardcoded 10 GB


def test_allows_file_at_or_under_limit(monkeypatch):
    monkeypatch.setattr(settings, "max_upload_bytes", 2 * 1024 * 1024 * 1024)  # 2 GB cap
    assert upload_size_error(2 * 1024 * 1024 * 1024) is None  # exactly at the cap
    assert upload_size_error(1 * 1024 * 1024 * 1024) is None  # under the cap
