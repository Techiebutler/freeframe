"""Non-AWS S3 compatibility: path-style + SigV4 clients and per-origin CORS rules.

Self-hosted S3 backends (Garage, MinIO) need path-style addressing (no wildcard
bucket DNS behind a reverse proxy) and SigV4 query auth (Garage rejects SigV2).
Garage also joins a CORS rule's AllowedOrigins into one comma-separated
Access-Control-Allow-Origin header — which browsers reject — so the startup CORS
config must emit one rule per origin.
"""
import pytest
from botocore.config import Config

from apps.api.config import settings
from apps.api.services import s3_service
from apps.api.services.s3_service import (
    _build_s3_client,
    _get_presign_client,
    ensure_bucket_exists,
)


@pytest.fixture(autouse=True)
def _clear_presign_cache():
    _get_presign_client.cache_clear()
    yield
    _get_presign_client.cache_clear()


@pytest.fixture
def captured_client(monkeypatch):
    calls = {}

    def fake_client(service, **kwargs):
        calls.update(kwargs)
        return object()

    monkeypatch.setattr(s3_service.boto3, "client", fake_client)
    return calls


def _client_config(calls) -> Config:
    assert "config" in calls, "expected a botocore Config on the client"
    return calls["config"]


def test_non_aws_client_forces_path_style_and_sigv4(monkeypatch, captured_client):
    monkeypatch.setattr(settings, "s3_storage", "minio")

    _build_s3_client()

    cfg = _client_config(captured_client)
    assert cfg.signature_version == "s3v4"
    assert cfg.s3["addressing_style"] == "path"
    assert captured_client["endpoint_url"] == settings.s3_endpoint


def test_non_aws_compat_config_merges_with_caller_config(monkeypatch, captured_client):
    monkeypatch.setattr(settings, "s3_storage", "minio")

    _build_s3_client(config=Config(connect_timeout=5, read_timeout=10))

    cfg = _client_config(captured_client)
    # Caller options (startup timeouts) and compat options must both survive.
    assert cfg.connect_timeout == 5
    assert cfg.read_timeout == 10
    assert cfg.signature_version == "s3v4"
    assert cfg.s3["addressing_style"] == "path"


def test_compat_config_wins_over_conflicting_caller_config(monkeypatch, captured_client):
    """The compat baseline is authoritative: a caller cannot downgrade it.

    botocore's `Config.merge` lets the argument win and replaces the `s3` sub-dict
    wholesale, so the merge direction is what makes this hold.
    """
    monkeypatch.setattr(settings, "s3_storage", "minio")

    _build_s3_client(
        config=Config(signature_version="s3", s3={"addressing_style": "virtual"})
    )

    cfg = _client_config(captured_client)
    assert cfg.signature_version == "s3v4"
    assert cfg.s3["addressing_style"] == "path"


def test_aws_client_has_no_endpoint_and_no_path_style(monkeypatch, captured_client):
    """AWS mode must not get an endpoint_url (#175) nor path-style addressing.

    It does get a config now — SigV4 is pinned in every mode (#190) — so this
    asserts the real invariant rather than the absence of a config.
    """
    monkeypatch.setattr(settings, "s3_storage", "s3")

    _build_s3_client()

    assert "endpoint_url" not in captured_client
    cfg = _client_config(captured_client)
    assert cfg.signature_version == "s3v4"
    assert not (cfg.s3 or {}).get("addressing_style")


def test_aws_presign_client_pins_sigv4(monkeypatch, captured_client):
    monkeypatch.setattr(settings, "s3_storage", "s3")

    _get_presign_client()

    assert "endpoint_url" not in captured_client
    cfg = _client_config(captured_client)
    assert cfg.signature_version == "s3v4"


@pytest.mark.parametrize("region", ["us-east-1", "eu-central-1"])
def test_aws_presigned_url_is_sigv4_in_every_region(monkeypatch, region):
    """The regression #190 is about: in us-east-1 botocore silently downgrades
    *presigned* URLs to SigV2 unless signature_version is pinned.

    This must assert on the generated URL, not the config — the config reports
    "s3v4" either way, because the downgrade happens at the signer.
    """
    monkeypatch.setattr(settings, "s3_storage", "s3")
    monkeypatch.setattr(settings, "s3_region", region)
    monkeypatch.setattr(settings, "s3_access_key", "AKIAIOSFODNN7EXAMPLE")
    monkeypatch.setattr(settings, "s3_secret_key", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")

    url = _get_presign_client().generate_presigned_url(
        "put_object",
        Params={"Bucket": "example-bucket", "Key": "some/object.mp4"},
        ExpiresIn=900,
    )

    assert "X-Amz-Algorithm=AWS4-HMAC-SHA256" in url, url
    assert "AWSAccessKeyId=" not in url, f"SigV2 presigned URL in {region}: {url}"


def test_presign_client_forces_path_style_and_sigv4(monkeypatch, captured_client):
    monkeypatch.setattr(settings, "s3_storage", "minio")

    _get_presign_client()

    cfg = _client_config(captured_client)
    assert cfg.signature_version == "s3v4"
    assert cfg.s3["addressing_style"] == "path"


class _FakeS3:
    """Records put_bucket_cors; everything else succeeds silently."""

    def __init__(self):
        self.cors_config = None

    def head_bucket(self, **kwargs):
        return {}

    def put_bucket_cors(self, Bucket, CORSConfiguration):
        self.cors_config = CORSConfiguration

    def put_bucket_policy(self, **kwargs):
        return {}


def test_startup_cors_emits_one_rule_per_origin(monkeypatch):
    monkeypatch.setattr(settings, "s3_storage", "minio")
    monkeypatch.setattr(settings, "frontend_url", "https://freeframe.example.com")
    fake = _FakeS3()
    monkeypatch.setattr(s3_service, "_build_s3_client", lambda config=None: fake)

    ensure_bucket_exists()

    rules = fake.cors_config["CORSRules"]
    assert len(rules) == 2
    assert [r["AllowedOrigins"] for r in rules] == [
        ["https://freeframe.example.com"],
        ["http://localhost:3000"],
    ]
    for rule in rules:
        assert "ETag" in rule["ExposeHeaders"]


def test_startup_cors_dedupes_frontend_localhost(monkeypatch):
    monkeypatch.setattr(settings, "s3_storage", "minio")
    monkeypatch.setattr(settings, "frontend_url", "http://localhost:3000")
    fake = _FakeS3()
    monkeypatch.setattr(s3_service, "_build_s3_client", lambda config=None: fake)

    ensure_bucket_exists()

    rules = fake.cors_config["CORSRules"]
    assert len(rules) == 1
    assert rules[0]["AllowedOrigins"] == ["http://localhost:3000"]
