"""The S3 clients are constructed once and reused (issue #132).

`hls_proxy` presigns one URL per HLS segment; without caching, a long VOD
manifest re-created a boto3 client per segment (~7s for a 55-min video). The
client factories must build the client once and reuse it.
"""
from unittest.mock import MagicMock

import pytest

from apps.api.services import s3_service
from apps.api.services.s3_service import get_s3_client, _get_presign_client


@pytest.fixture(autouse=True)
def _clear_client_caches():
    # Reset the caches around each test (guarded so this also works before the
    # @lru_cache is added — i.e. during the red phase).
    for fn in (get_s3_client, _get_presign_client):
        getattr(fn, "cache_clear", lambda: None)()
    yield
    for fn in (get_s3_client, _get_presign_client):
        getattr(fn, "cache_clear", lambda: None)()


def test_get_s3_client_built_once_and_reused(monkeypatch):
    calls = {"n": 0}

    def fake_client(*args, **kwargs):
        calls["n"] += 1
        return object()

    monkeypatch.setattr(s3_service.boto3, "client", fake_client)

    first = get_s3_client()
    second = get_s3_client()

    assert first is second
    assert calls["n"] == 1


def test_presign_client_built_once_and_reused(monkeypatch):
    calls = {"n": 0}

    def fake_client(*args, **kwargs):
        calls["n"] += 1
        return object()

    monkeypatch.setattr(s3_service.boto3, "client", fake_client)

    first = _get_presign_client()
    second = _get_presign_client()

    assert first is second
    assert calls["n"] == 1


def test_internal_presigned_get_url_uses_probe_client(monkeypatch):
    calls = {}
    fake_client = MagicMock()

    def generate_presigned_url(operation, Params, ExpiresIn):
        calls["operation"] = operation
        calls["params"] = Params
        calls["expires_in"] = ExpiresIn
        return "http://minio:9000/test-bucket/raw/video.mov?signature=test"

    fake_client.generate_presigned_url.side_effect = generate_presigned_url
    monkeypatch.setattr(s3_service, "_get_probe_client", lambda: fake_client)
    monkeypatch.setattr(s3_service.settings, "s3_bucket", "test-bucket")

    url = s3_service.generate_internal_presigned_get_url("raw/video.mov", expires_in=300)

    assert url.startswith("http://minio:9000/")
    assert calls == {
        "operation": "get_object",
        "params": {"Bucket": "test-bucket", "Key": "raw/video.mov"},
        "expires_in": 300,
    }
