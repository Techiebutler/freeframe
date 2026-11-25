"""botocore 1.44 made 'standard' the default retry mode; ours stays 'legacy'."""
import pytest

from apps.api.services import s3_service

CLIENTS = [
    (lambda: s3_service._build_s3_client(), None),
    (lambda: s3_service._build_s3_client(s3_service._STARTUP_S3_CONFIG), 3),
    (lambda: s3_service._build_s3_client(s3_service._PROBE_S3_CONFIG), 3),
    (lambda: s3_service._build_s3_client(s3_service._INITIATE_S3_CONFIG), 1),
    (lambda: s3_service._build_s3_client(s3_service._ABORT_S3_CONFIG), 2),
    (lambda: s3_service._build_s3_client(s3_service._LISTING_S3_CONFIG), 3),
]


@pytest.mark.parametrize("storage", ["minio", "s3"])
@pytest.mark.parametrize("build,attempts", CLIENTS, ids=["shared", "startup", "probe", "initiate", "abort", "listing"])
def test_retry_mode_is_legacy_and_the_budget_survives(monkeypatch, storage, build, attempts):
    monkeypatch.setattr(s3_service.settings, "s3_storage", storage)
    retries = build().meta.config.retries
    assert retries["mode"] == "legacy"
    assert retries.get("total_max_attempts") == attempts
