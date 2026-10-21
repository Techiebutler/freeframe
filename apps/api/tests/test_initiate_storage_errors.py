"""Starting an upload must fail fast and say why.

CreateMultipartUpload is the one storage call the user waits on before a byte is
sent, and it used to run on the shared client: boto3's ~60 s timeouts with
retries behind them, then an uncaught exception that surfaced as a bare 500. The
web queue can only back off and retry when the answer says the outage is
transient, so the call is bounded and its failures are coded.
"""
import uuid
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import (
    ClientError, ConnectionClosedError, ConnectTimeoutError, EndpointConnectionError,
    HTTPClientError, ParamValidationError, ProxyConnectionError, ReadTimeoutError, SSLError,
)

import apps.api.routers.assets as assets_module
import apps.api.routers.upload as upload_module
from apps.api.config import settings
from apps.api.services import s3_service


# -- the bounded client -------------------------------------------------------

def test_initiate_client_is_bounded_and_single_shot():
    s3_service._get_initiate_client.cache_clear()
    cfg = s3_service._get_initiate_client().meta.config
    assert cfg.connect_timeout == 5
    assert cfg.read_timeout == 10
    # botocore adds 'mode' itself; what matters is one request, no retries key
    assert cfg.retries["total_max_attempts"] == 1
    assert "max_attempts" not in cfg.retries
    assert cfg.signature_version == "s3v4"


def test_create_multipart_upload_uses_the_bounded_client(monkeypatch):
    calls = []

    class _Client:
        def create_multipart_upload(self, **kwargs):
            calls.append(kwargs)
            return {"UploadId": "upload-1"}

    monkeypatch.setattr(s3_service, "_get_initiate_client", lambda: _Client())
    monkeypatch.setattr(
        s3_service, "get_s3_client",
        lambda: (_ for _ in ()).throw(AssertionError("the shared client must not start uploads")),
    )

    assert s3_service.create_multipart_upload("raw/p/a/v/original.mp4", "video/mp4") == "upload-1"
    assert calls == [{
        "Bucket": s3_service.settings.s3_bucket,
        "Key": "raw/p/a/v/original.mp4",
        "ContentType": "video/mp4",
    }]


# -- coded answers on both initiate routes ------------------------------------

ENDPOINT = "http://storage:9000"
ROUTES = ["new_asset", "new_version"]


def _client_error(code, status, op="CreateMultipartUpload"):
    return ClientError(
        {"Error": {"Code": code, "Message": code}, "ResponseMetadata": {"HTTPStatusCode": status}},
        op,
    )


def _initiate_failing(client, auth_headers, mock_db, monkeypatch, path, exc):
    """Run one initiate route with storage raising `exc` when the upload is started."""
    def _raise(key, mime):
        raise exc

    for mod in (upload_module, assets_module):
        monkeypatch.setattr(mod, "upload_guard_error", lambda db, n: None)
        monkeypatch.setattr(mod, "choose_part_size", lambda db, n: (10 * 1024 * 1024, None))
        monkeypatch.setattr(mod, "require_project_role", lambda *a, **k: None)
        monkeypatch.setattr(mod, "next_version_number", lambda db, a: 1)
        monkeypatch.setattr(mod, "create_multipart_upload", _raise)

    def _add(obj):
        if getattr(obj, "id", None) is None:
            obj.id = uuid.uuid4()

    mock_db.add.side_effect = _add
    project_id = uuid.uuid4()
    body = {
        "project_id": str(project_id),
        "asset_name": "clip",
        "original_filename": "clip.mov",
        "mime_type": "video/quicktime",
        "file_size_bytes": 1024,
    }
    if path == "new_asset":
        mock_db.first.return_value = MagicMock()  # the project
        return client.post("/upload/initiate", json=body, headers=auth_headers)
    mock_db.first.return_value = MagicMock(project_id=project_id)  # the asset
    return client.post(f"/assets/{uuid.uuid4()}/versions", json=body, headers=auth_headers)


def _detail(resp):
    try:
        detail = resp.json().get("detail")
    except ValueError:
        return None
    return detail if isinstance(detail, dict) else None


@pytest.mark.parametrize("path", ROUTES)
@pytest.mark.parametrize("exc", [
    EndpointConnectionError(endpoint_url=ENDPOINT),
    ConnectTimeoutError(endpoint_url=ENDPOINT),
    ProxyConnectionError(proxy_url="http://proxy:3128"),
    ReadTimeoutError(endpoint_url=ENDPOINT),
    ConnectionClosedError(endpoint_url=ENDPOINT),
    HTTPClientError(error="boom"),
], ids=lambda e: type(e).__name__)
def test_connection_failures_answer_coded_503(
    client, auth_headers, mock_db, monkeypatch, path, exc
):
    resp = _initiate_failing(client, auth_headers, mock_db, monkeypatch, path, exc)

    assert resp.status_code == 503, resp.text
    detail = _detail(resp)
    assert detail["code"] == "storage_unavailable"
    assert detail["retry_after"] == 5
    assert detail["message"] == "Could not reach storage to start this upload. Please retry."
    assert resp.headers["Retry-After"] == "5"
    mock_db.commit.assert_not_called()


@pytest.mark.parametrize("path", ROUTES)
@pytest.mark.parametrize("code, status", [
    ("BadGateway", 502),
    ("SlowDown", 503),
    ("InternalError", 500),
    # Named throttling/timeout codes count even when the backend answers them with a
    # 4xx, which some S3-compatible stores do.
    ("RequestTimeout", 400),
    ("SlowDown", 400),
    ("ServiceUnavailable", 400),
    ("InternalError", 400),
])
def test_storage_5xx_and_throttling_answer_coded_503(
    client, auth_headers, mock_db, monkeypatch, path, code, status
):
    resp = _initiate_failing(
        client, auth_headers, mock_db, monkeypatch, path, _client_error(code, status)
    )

    assert resp.status_code == 503, resp.text
    detail = _detail(resp)
    assert detail["code"] == "storage_unavailable"
    assert detail["retry_after"] == 5
    assert resp.headers["Retry-After"] == "5"
    mock_db.commit.assert_not_called()


@pytest.mark.parametrize("path", ROUTES)
@pytest.mark.parametrize("exc", [
    _client_error("AccessDenied", 403),
    _client_error("NoSuchBucket", 404),
    # A certificate problem is a configuration fault that waiting will not fix, even
    # though botocore files SSLError under ConnectionError.
    SSLError(endpoint_url=ENDPOINT, error="certificate verify failed"),
], ids=["AccessDenied", "NoSuchBucket", "SSLError"])
def test_storage_refusals_answer_coded_500(
    client, auth_headers, mock_db, monkeypatch, path, exc
):
    resp = _initiate_failing(client, auth_headers, mock_db, monkeypatch, path, exc)

    assert resp.status_code == 500, resp.text
    detail = _detail(resp)
    assert detail == {
        "code": "storage_error",
        "message": "Storage refused the upload. Ask your admin to check the storage settings.",
    }
    assert "Retry-After" not in resp.headers
    mock_db.commit.assert_not_called()


@pytest.mark.parametrize("path", ROUTES)
def test_programming_errors_stay_plain_500(client, auth_headers, mock_db, monkeypatch, path):
    resp = _initiate_failing(
        client, auth_headers, mock_db, monkeypatch, path,
        ParamValidationError(report="Invalid bucket name"),
    )

    assert resp.status_code == 500
    assert _detail(resp) is None or "code" not in _detail(resp)
    mock_db.commit.assert_not_called()


@pytest.mark.parametrize("path", ROUTES)
@pytest.mark.parametrize("exc", [
    EndpointConnectionError(endpoint_url=ENDPOINT),
    _client_error("AccessDenied", 403),
], ids=["503", "500"])
def test_rollback_called_before_coded_error(client, auth_headers, mock_db, monkeypatch, path, exc):
    resp = _initiate_failing(client, auth_headers, mock_db, monkeypatch, path, exc)

    assert _detail(resp) is not None
    mock_db.rollback.assert_called_once()


# -- the browser can read Retry-After -----------------------------------------

def test_retry_after_is_exposed_cross_origin(client):
    # A GET, not a preflight: a preflight response never carries this header.
    # An origin the middleware allows, whatever FRONTEND_URL / CORS_ALLOW_ORIGINS say.
    origin = "http://localhost:3000" if settings.cors_allows_any_origin else settings.cors_origins[0]
    resp = client.get("/health", headers={"Origin": origin})

    exposed = resp.headers["access-control-expose-headers"].lower()
    assert "retry-after" in exposed
    # The header the download filename already depends on must survive the edit.
    assert "content-disposition" in exposed
