"""Starting an upload must fail fast and say why.

CreateMultipartUpload is the one storage call the user waits on before a byte is
sent, and it used to run on the shared client: boto3's ~60 s timeouts with
retries behind them, then an uncaught exception that surfaced as a bare 500. The
web queue can only back off and retry when the answer says the outage is
transient, so the call is bounded and its failures are coded.
"""
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
