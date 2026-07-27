"""Prod-hardening from the v1.4.0 deploy test.

- run_startup_bucket_setup(): the app must not crash/hang if S3 is slow or
  unreachable at startup — the bucket check runs off the request path and its
  failures are swallowed + logged (issue: 60s startup block, #6).
- mail_is_configured(): detect an unconfigured mailer so startup can warn that
  magic-code login will fail (issue: SMTP-required, #2).
"""
import logging

from apps.api.config import settings
from apps.api.services import s3_service
from apps.api.services.s3_service import run_startup_bucket_setup
from apps.api.services.email_service import mail_is_configured


def test_startup_bucket_setup_swallows_and_logs_failure(monkeypatch, caplog):
    calls = {"n": 0}

    def boom():
        calls["n"] += 1
        raise RuntimeError("S3 unreachable")

    monkeypatch.setattr(s3_service, "ensure_bucket_exists", boom)
    with caplog.at_level(logging.WARNING):
        # inject a no-op sleep so the retries don't actually wait
        run_startup_bucket_setup(attempts=4, base_delay=0, _sleep=lambda *_: None)  # must NOT raise
    assert calls["n"] == 4, "expected it to retry the bucket check before giving up"
    assert any(
        "storage" in r.getMessage().lower() or "s3" in r.getMessage().lower()
        for r in caplog.records
    ), "expected a warning naming storage/S3"


def test_startup_bucket_setup_retries_transient_failure_until_success(monkeypatch):
    """A store that's briefly unreachable at startup must self-heal without a restart."""
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("S3 temporarily unreachable")
        # third attempt succeeds

    monkeypatch.setattr(s3_service, "ensure_bucket_exists", flaky)
    run_startup_bucket_setup(attempts=5, base_delay=0, _sleep=lambda *_: None)
    assert calls["n"] == 3, "expected it to keep retrying a transient failure until it succeeds"


def test_startup_bucket_setup_runs_the_check_on_success(monkeypatch):
    calls = {"n": 0}
    monkeypatch.setattr(s3_service, "ensure_bucket_exists", lambda: calls.__setitem__("n", calls["n"] + 1))
    run_startup_bucket_setup()
    assert calls["n"] == 1, "a first-attempt success must not retry"


def test_mail_not_configured_when_smtp_host_empty(monkeypatch):
    monkeypatch.setattr(settings, "mail_provider", "smtp")
    monkeypatch.setattr(settings, "smtp_host", None)
    assert mail_is_configured() is False


def test_mail_configured_when_smtp_host_set(monkeypatch):
    monkeypatch.setattr(settings, "mail_provider", "smtp")
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
    assert mail_is_configured() is True
