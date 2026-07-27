"""Validation of S3_STORAGE / S3_ENDPOINT consistency in Settings.

`S3_STORAGE=s3` selects native AWS S3 and ignores S3_ENDPOINT. Pairing it with a
real custom (non-AWS) endpoint is a misconfiguration that used to silently route
to AWS; it must now fail loudly at Settings load.
"""
import pytest
from pydantic import ValidationError

from apps.api.config import Settings

DEFAULT_MINIO_ENDPOINT = "http://minio:9000"


def _settings(**overrides):
    """Build a Settings instance from explicit values, bypassing the env file.

    Required fields are supplied; s3_* values are passed as kwargs (which take
    precedence over any S3_* env vars the test runner set), so each case is
    deterministic.
    """
    base = dict(
        database_url="postgresql://u:p@localhost:5432/db",
        redis_url="redis://localhost:6379/0",
        jwt_secret="test-secret",
    )
    base.update(overrides)
    return Settings(_env_file=None, **base)


def test_s3_mode_with_custom_non_aws_endpoint_raises():
    with pytest.raises(ValidationError, match="S3_STORAGE=s3"):
        _settings(s3_storage="s3", s3_endpoint="https://acct.r2.cloudflarestorage.com")


def test_s3_mode_is_case_insensitive():
    with pytest.raises(ValidationError):
        _settings(s3_storage="S3", s3_endpoint="https://s3.example-compat.com")


def test_s3_mode_with_empty_endpoint_ok():
    s = _settings(s3_storage="s3", s3_endpoint="")
    assert s.s3_storage == "s3"


def test_s3_mode_with_default_minio_endpoint_ok():
    # An untouched default is not a meaningful override; it is ignored in s3 mode.
    s = _settings(s3_storage="s3", s3_endpoint=DEFAULT_MINIO_ENDPOINT)
    assert s.s3_endpoint == DEFAULT_MINIO_ENDPOINT


def test_s3_mode_with_aws_endpoint_ok():
    s = _settings(s3_storage="s3", s3_endpoint="https://s3.us-west-2.amazonaws.com")
    assert s.s3_storage == "s3"


def test_minio_mode_with_custom_endpoint_ok():
    s = _settings(s3_storage="minio", s3_endpoint="https://acct.r2.cloudflarestorage.com")
    assert s.s3_storage == "minio"
