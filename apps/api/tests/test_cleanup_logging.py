"""Log levels of the maintenance tasks' outcome lines (#262).

An operator who runs the workers at a quiet level still has to be told two
things: what the retention GC irreversibly removed, and that a sweep is
switched off. Those lines are WARNING; the routine "nothing happened" result
stays at INFO so a quiet level stays quiet.
"""
import logging

import apps.api.tasks.cleanup_tasks as ct
from apps.api.config import settings
from apps.api.tests.conftest import _make_mock_db


def _records(caplog, prefix):
    return [r for r in caplog.records if r.name == "celery.cleanup" and r.getMessage().startswith(prefix)]


def _run_gc_task(monkeypatch, counts):
    db = _make_mock_db()
    monkeypatch.setattr(ct, "SessionLocal", lambda: db)
    monkeypatch.setattr(ct, "_run_cleanup", lambda _db: counts)
    return ct.cleanup_soft_deleted()


def test_gc_result_that_deleted_something_is_a_warning(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="celery.cleanup")
    _run_gc_task(monkeypatch, ct.PurgeCounts(retention_days=30, assets=2, s3_deletes=5))

    [rec] = _records(caplog, "cleanup: {")
    assert rec.levelno == logging.WARNING
    assert "'s3_deletes': 5" in rec.getMessage()


def test_gc_result_that_deleted_nothing_stays_info(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="celery.cleanup")
    # retention_days is configuration, not work done: it alone must not promote the line.
    _run_gc_task(monkeypatch, ct.PurgeCounts(retention_days=30))

    [rec] = _records(caplog, "cleanup: {")
    assert rec.levelno == logging.INFO


def test_retention_gc_disabled_is_a_warning(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="celery.cleanup")
    monkeypatch.setattr(settings, "soft_delete_retention_days", 0)
    ct._purge_soft_deleted(_make_mock_db(), ct.PurgeCounts())

    [rec] = _records(caplog, "cleanup: disabled")
    assert rec.levelno == logging.WARNING


def test_reaper_disabled_is_a_warning(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="celery.cleanup")
    monkeypatch.setattr(settings, "stale_upload_timeout_hours", 0)
    assert ct._reap_stale_uploads(_make_mock_db()) == 0

    [rec] = _records(caplog, "reaper: disabled")
    assert rec.levelno == logging.WARNING


def test_requeue_disabled_is_a_warning(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="celery.cleanup")
    monkeypatch.setattr(settings, "stuck_processing_timeout_hours", 0)
    assert ct.requeue_stuck_processing() == 0

    [rec] = _records(caplog, "requeue: disabled")
    assert rec.levelno == logging.WARNING


def test_orphan_sweep_disabled_is_a_warning(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="celery.cleanup")
    monkeypatch.setattr(settings, "orphan_sweep_grace_hours", 0)
    ct._sweep_orphan_s3(_make_mock_db())

    [rec] = _records(caplog, "orphan-sweep: disabled")
    assert rec.levelno == logging.WARNING
