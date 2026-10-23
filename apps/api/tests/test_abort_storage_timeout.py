"""Aborting an upload must give up promptly when storage hangs (#523).

AbortMultipartUpload ran on the shared client: boto3's ~60 s connect and read
timeouts with retries behind them, so with the storage container paused one
`POST /upload/abort` held a request thread for about 310 s. The route already
turns a storage that cannot be reached into a 503 with Retry-After; the call
just has to get there in seconds.
"""
from apps.api.services import s3_service


def test_abort_client_is_bounded():
    s3_service._get_abort_client.cache_clear()
    cfg = s3_service._get_abort_client().meta.config
    assert cfg.connect_timeout == 5
    assert cfg.read_timeout == 10
    # The first request and one retry: a repeat of an abort whose answer was
    # lost finds NoSuchUpload, which the route already treats as "already gone".
    assert cfg.retries["total_max_attempts"] == 2
    assert cfg.signature_version == "s3v4"


def test_abort_multipart_upload_uses_the_bounded_client(monkeypatch):
    calls = []

    class _Client:
        def abort_multipart_upload(self, **kwargs):
            calls.append(kwargs)

    monkeypatch.setattr(s3_service, "_get_abort_client", lambda: _Client(), raising=False)
    monkeypatch.setattr(
        s3_service, "get_s3_client",
        lambda: (_ for _ in ()).throw(AssertionError("the shared client must not abort uploads")),
    )

    s3_service.abort_multipart_upload("raw/p/a/v/original.mp4", "upload-1")
    assert calls == [{
        "Bucket": s3_service.settings.s3_bucket,
        "Key": "raw/p/a/v/original.mp4",
        "UploadId": "upload-1",
    }]


def test_complete_stays_on_the_long_timeout_client(monkeypatch):
    # CompleteMultipartUpload can legitimately take minutes to assemble a large
    # object; cutting it off at the abort's timeouts would fail a working upload.
    calls = []

    class _Client:
        def complete_multipart_upload(self, **kwargs):
            calls.append(kwargs)

    monkeypatch.setattr(s3_service, "get_s3_client", lambda: _Client())
    monkeypatch.setattr(
        s3_service, "_get_abort_client",
        lambda: (_ for _ in ()).throw(AssertionError("complete must not use the abort client")),
        raising=False,
    )

    s3_service.complete_multipart_upload("k", "u", [{"PartNumber": 1, "ETag": '"e"'}])
    assert len(calls) == 1
