"""Garage compares bucket-CORS `AllowedHeaders` case-sensitively.

Browsers lowercase every name in `Access-Control-Request-Headers` (Fetch
spec), so a rule that signs "Content-Type" never matches the "content-type"
a presigned-PUT preflight asks for and the upload fails CORS. AWS S3 and
MinIO match case-insensitively, which is why this only surfaced on Garage.
"""
from unittest.mock import MagicMock

from apps.api.services import s3_service


def test_allowed_headers_are_lowercase(monkeypatch):
    client = MagicMock()
    monkeypatch.setattr(s3_service, "_build_s3_client", lambda config=None: client)
    monkeypatch.setattr(s3_service, "_is_aws_s3", lambda: False)

    s3_service.ensure_bucket_exists()

    call = client.put_bucket_cors.call_args
    assert call is not None, "ensure_bucket_exists did not set bucket CORS"
    rules = call.kwargs["CORSConfiguration"]["CORSRules"]
    assert rules, "no CORS rules were written"
    expected = [
        "content-type",
        "content-md5",
        "x-amz-content-sha256",
        "x-amz-date",
        "x-amz-decoded-content-length",
    ]
    for rule in rules:
        assert rule["AllowedHeaders"] == expected
