"""Tests for the stale-upload reaper and its S3 helpers."""
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock

from apps.api.services import s3_service


def test_list_stale_multipart_uploads_filters_by_initiated(monkeypatch):
    now = datetime.now(timezone.utc)
    fake = MagicMock()
    fake.list_multipart_uploads.return_value = {
        "Uploads": [
            {"Key": "raw/old", "UploadId": "u1", "Initiated": now - timedelta(hours=48)},
            {"Key": "raw/new", "UploadId": "u2", "Initiated": now - timedelta(hours=1)},
        ],
        "IsTruncated": False,
    }
    monkeypatch.setattr(s3_service, "get_s3_client", lambda: fake)
    result = s3_service.list_stale_multipart_uploads(now - timedelta(hours=24))
    assert result == [("raw/old", "u1")]


def test_delete_prefix_deletes_all_listed(monkeypatch):
    fake = MagicMock()
    fake.list_objects_v2.return_value = {
        "Contents": [{"Key": "p/a"}, {"Key": "p/b"}], "IsTruncated": False,
    }
    monkeypatch.setattr(s3_service, "get_s3_client", lambda: fake)
    s3_service.delete_prefix("p/")
    _, kwargs = fake.delete_objects.call_args
    assert kwargs["Delete"]["Objects"] == [{"Key": "p/a"}, {"Key": "p/b"}]


def test_delete_prefix_noop_when_empty(monkeypatch):
    fake = MagicMock()
    fake.list_objects_v2.return_value = {"Contents": [], "IsTruncated": False}
    monkeypatch.setattr(s3_service, "get_s3_client", lambda: fake)
    s3_service.delete_prefix("p/")
    fake.delete_objects.assert_not_called()
