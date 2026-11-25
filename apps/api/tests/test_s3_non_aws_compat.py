"""Non-AWS S3 compatibility: path-style + SigV4 clients and per-origin CORS rules.

Self-hosted S3 backends (Garage, MinIO) need path-style addressing (no wildcard
bucket DNS behind a reverse proxy) and SigV4 query auth (Garage rejects SigV2).
Garage also joins a CORS rule's AllowedOrigins into one comma-separated
Access-Control-Allow-Origin header — which browsers reject — so the startup CORS
config must emit one rule per origin.

Also the startup removal of the public-read policy that v1.0.0 to v1.9.x wrote.
"""
import json

import pytest
from botocore.config import Config
from botocore.exceptions import ClientError

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

    def get_bucket_policy(self, **kwargs):
        raise ClientError({"Error": {"Code": "NoSuchBucketPolicy"}}, "GetBucketPolicy")


def test_startup_cors_emits_one_rule_per_origin(monkeypatch):
    monkeypatch.setattr(settings, "s3_storage", "minio")
    monkeypatch.setattr(settings, "frontend_url", "https://freeframe.example.com")
    monkeypatch.setattr(settings, "cors_allow_origins", "")
    fake = _FakeS3()
    monkeypatch.setattr(s3_service, "_build_s3_client", lambda config=None: fake)

    ensure_bucket_exists()

    rules = fake.cors_config["CORSRules"]
    assert [r["AllowedOrigins"] for r in rules] == [
        ["https://freeframe.example.com"],
        ["http://localhost:3000"],
        ["http://localhost:3001"],
    ]
    for rule in rules:
        assert "ETag" in rule["ExposeHeaders"]


def test_startup_cors_dedupes_frontend_localhost(monkeypatch):
    monkeypatch.setattr(settings, "s3_storage", "minio")
    monkeypatch.setattr(settings, "frontend_url", "http://localhost:3000")
    monkeypatch.setattr(settings, "cors_allow_origins", "")
    fake = _FakeS3()
    monkeypatch.setattr(s3_service, "_build_s3_client", lambda config=None: fake)

    ensure_bucket_exists()

    rules = fake.cors_config["CORSRules"]
    assert [r["AllowedOrigins"] for r in rules] == [["http://localhost:3000"], ["http://localhost:3001"]]


def test_startup_cors_includes_cors_allow_origins(monkeypatch):
    # An extra origin the API accepts must also reach the bucket, or a store that
    # enforces bucket CORS (Silo, Garage) refuses its uploads and playback.
    monkeypatch.setattr(settings, "s3_storage", "minio")
    monkeypatch.setattr(settings, "frontend_url", "https://freeframe.example.com")
    monkeypatch.setattr(settings, "cors_allow_origins", " https://review.example.com, ,http://localhost:3000 ")
    fake = _FakeS3()
    monkeypatch.setattr(s3_service, "_build_s3_client", lambda config=None: fake)

    ensure_bucket_exists()

    assert [r["AllowedOrigins"] for r in fake.cors_config["CORSRules"]] == [
        ["https://freeframe.example.com"],
        ["http://localhost:3000"],
        ["http://localhost:3001"],
        ["https://review.example.com"],
    ]


def test_startup_cors_matches_api_cors_origins(monkeypatch):
    # One list feeds both, so an origin the API accepts can never be one the
    # bucket refuses.
    monkeypatch.setattr(settings, "s3_storage", "minio")
    monkeypatch.setattr(settings, "frontend_url", "https://host.example.com/freeframe")
    monkeypatch.setattr(settings, "cors_allow_origins", "https://a.example.com,https://b.example.com")
    fake = _FakeS3()
    monkeypatch.setattr(s3_service, "_build_s3_client", lambda config=None: fake)

    ensure_bucket_exists()

    bucket = [o for r in fake.cors_config["CORSRules"] for o in r["AllowedOrigins"]]
    assert bucket == settings.cors_origins
    assert "https://host.example.com" in bucket


def test_startup_cors_skips_origins_s3_rejects(monkeypatch):
    # S3 refuses the whole configuration over one bad AllowedOrigin, which would
    # take the FRONTEND_URL rule down with it.
    monkeypatch.setattr(settings, "s3_storage", "minio")
    monkeypatch.setattr(settings, "frontend_url", "https://freeframe.example.com")
    monkeypatch.setattr(settings, "cors_allow_origins", "https://*.*.example.com,https://x.example.com?a=1,https://ok.example.com")
    fake = _FakeS3()
    monkeypatch.setattr(s3_service, "_build_s3_client", lambda config=None: fake)

    ensure_bucket_exists()

    assert [r["AllowedOrigins"] for r in fake.cors_config["CORSRules"]] == [
        ["https://freeframe.example.com"],
        ["http://localhost:3000"],
        ["http://localhost:3001"],
        ["https://ok.example.com"],
    ]


def test_startup_cors_wildcard_allows_any_origin(monkeypatch):
    monkeypatch.setattr(settings, "s3_storage", "minio")
    monkeypatch.setattr(settings, "frontend_url", "https://freeframe.example.com")
    monkeypatch.setattr(settings, "cors_allow_origins", "https://review.example.com,*")
    fake = _FakeS3()
    monkeypatch.setattr(s3_service, "_build_s3_client", lambda config=None: fake)

    ensure_bucket_exists()

    rules = fake.cors_config["CORSRules"]
    assert [r["AllowedOrigins"] for r in rules] == [["*"]]
    assert "ETag" in rules[0]["ExposeHeaders"]

# ── the public-read policy that v1.0.0 to v1.9.x wrote ───────────────────────

_OLD_STATEMENT = {
    "Sid": "PublicReadProcessed",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::ffbucket/processed/*",
}
# MinIO and Silo hand back what was written in this shape (measured).
_OLD_STATEMENT_AS_STORED = {
    "Sid": "PublicReadProcessed",
    "Effect": "Allow",
    "Principal": {"AWS": ["*"]},
    "Action": ["s3:GetObject"],
    "Resource": ["arn:aws:s3:::ffbucket/processed/*"],
}
_OPERATORS = {
    "Sid": "Operators",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::ffbucket/public/*",
}


class _PolicyS3(_FakeS3):
    """Holds a bucket policy. `fail` maps an operation to the error it raises."""

    def __init__(self, statements=None, fail=None, raw=None):
        super().__init__()
        self.policy = raw if raw is not None else (
            None if statements is None else json.dumps({"Version": "2012-10-17", "Statement": statements}))
        self.fail = fail or {}
        self.calls = []

    def _maybe_fail(self, name):
        self.calls.append(name)
        error = self.fail.get(name)
        if isinstance(error, Exception):
            raise error
        if error:
            raise ClientError({"Error": {"Code": error}}, name)

    def get_bucket_policy(self, Bucket):
        self._maybe_fail("GetBucketPolicy")
        if self.policy is None:
            raise ClientError({"Error": {"Code": "NoSuchBucketPolicy"}}, "GetBucketPolicy")
        return {"Policy": self.policy}

    def put_bucket_policy(self, Bucket, Policy):
        self._maybe_fail("PutBucketPolicy")
        self.policy = Policy

    def delete_bucket_policy(self, Bucket):
        self._maybe_fail("DeleteBucketPolicy")
        self.policy = None


def _start_against(monkeypatch, fake, storage="minio"):
    monkeypatch.setattr(settings, "s3_storage", storage)
    monkeypatch.setattr(settings, "s3_bucket", "ffbucket")
    monkeypatch.setattr(settings, "frontend_url", "https://freeframe.example.com")
    monkeypatch.setattr(settings, "cors_allow_origins", "")
    monkeypatch.setattr(s3_service, "_build_s3_client", lambda config=None: fake)
    ensure_bucket_exists()


@pytest.mark.parametrize("statement", [_OLD_STATEMENT, _OLD_STATEMENT_AS_STORED])
def test_startup_removes_the_old_public_policy(monkeypatch, caplog, statement):
    fake = _PolicyS3([statement])
    with caplog.at_level("WARNING"):
        _start_against(monkeypatch, fake)

    assert fake.policy is None
    assert "DeleteBucketPolicy" in fake.calls
    assert "PublicReadProcessed" in caplog.text


@pytest.mark.parametrize("statement", [_OLD_STATEMENT, _OLD_STATEMENT_AS_STORED])
def test_startup_keeps_the_statements_an_operator_added(monkeypatch, statement):
    fake = _PolicyS3([_OPERATORS, statement])
    _start_against(monkeypatch, fake)

    assert json.loads(fake.policy) == {"Version": "2012-10-17", "Statement": [_OPERATORS]}
    assert "DeleteBucketPolicy" not in fake.calls


@pytest.mark.parametrize("change", [
    {"Sid": "Mine"},
    {"Effect": "Deny"},
    {"Principal": {"AWS": ["arn:aws:iam::123456789012:root"]}},
    {"Action": ["s3:GetObject", "s3:ListBucket"]},
    {"Resource": "arn:aws:s3:::ffbucket/*"},
    {"Resource": "arn:aws:s3:::other/processed/*"},
    {"Condition": {"IpAddress": {"aws:SourceIp": "10.0.0.0/8"}}},
])
def test_startup_leaves_a_policy_it_did_not_write(monkeypatch, change):
    fake = _PolicyS3([{**_OLD_STATEMENT, **change}])
    before = fake.policy
    _start_against(monkeypatch, fake)

    assert fake.policy == before
    assert "PutBucketPolicy" not in fake.calls
    assert "DeleteBucketPolicy" not in fake.calls


def test_startup_removes_a_lone_statement_that_is_not_in_a_list(monkeypatch):
    fake = _PolicyS3(raw=json.dumps({"Version": "2012-10-17", "Statement": _OLD_STATEMENT}))
    _start_against(monkeypatch, fake)
    assert fake.policy is None


@pytest.mark.parametrize("fake", [
    _PolicyS3(),
    _PolicyS3(fail={"GetBucketPolicy": "NotImplemented"}),
    _PolicyS3(raw="not json"),
    _PolicyS3(raw="[]"),
    _PolicyS3(raw=json.dumps({"Statement": ["nonsense"]})),
])
def test_startup_survives_no_policy_and_stores_without_them(monkeypatch, caplog, fake):
    with caplog.at_level("WARNING"):
        _start_against(monkeypatch, fake)
    assert fake.calls == ["GetBucketPolicy"]
    assert "PublicReadProcessed" not in caplog.text


@pytest.mark.parametrize("operation, statements", [
    ("DeleteBucketPolicy", [_OLD_STATEMENT]),
    ("PutBucketPolicy", [_OPERATORS, _OLD_STATEMENT]),
])
def test_startup_warns_when_the_key_may_not_change_the_policy(monkeypatch, caplog, operation, statements):
    fake = _PolicyS3(statements, fail={operation: "AccessDenied"})
    with caplog.at_level("WARNING"):
        _start_against(monkeypatch, fake)
    assert "PublicReadProcessed" in caplog.text
    assert "without signing in" in caplog.text


def test_startup_does_not_warn_when_the_key_may_not_read_the_policy(monkeypatch, caplog):
    # A key kept to the object calls is a normal setup, and such a key could not
    # have written the policy.
    fake = _PolicyS3([_OLD_STATEMENT], fail={"GetBucketPolicy": "AccessDenied"})
    with caplog.at_level("INFO"):
        _start_against(monkeypatch, fake)
    assert [r.levelname for r in caplog.records if "bucket policy" in r.getMessage()] == ["INFO"]


def test_startup_does_not_read_the_policy_on_aws(monkeypatch):
    # v1.0.0 to v1.9.x wrote it on non-AWS stores only.
    fake = _PolicyS3([_OLD_STATEMENT])
    _start_against(monkeypatch, fake, storage="s3")
    assert fake.calls == []
