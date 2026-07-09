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
    def boom():
        raise RuntimeError("S3 unreachable")

    monkeypatch.setattr(s3_service, "ensure_bucket_exists", boom)
    with caplog.at_level(logging.WARNING):
        run_startup_bucket_setup()  # must NOT raise — app startup can't crash on S3
    assert any(
        "storage" in r.getMessage().lower() or "s3" in r.getMessage().lower()
        for r in caplog.records
    ), "expected a warning naming storage/S3"


def test_startup_bucket_setup_runs_the_check_on_success(monkeypatch):
    calls = {"n": 0}
    monkeypatch.setattr(s3_service, "ensure_bucket_exists", lambda: calls.__setitem__("n", calls["n"] + 1))
    run_startup_bucket_setup()
    assert calls["n"] == 1


def test_mail_not_configured_when_smtp_host_empty(monkeypatch):
    monkeypatch.setattr(settings, "mail_provider", "smtp")
    monkeypatch.setattr(settings, "smtp_host", None)
    assert mail_is_configured() is False


def test_mail_configured_when_smtp_host_set(monkeypatch):
    monkeypatch.setattr(settings, "mail_provider", "smtp")
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
    assert mail_is_configured() is True
