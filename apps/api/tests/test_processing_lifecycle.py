"""The `processing` status lifecycle: no oscillation (#271), no stranding (#270).

Both were attempted before and reverted. #271's revert was caused by the retry
path: writing `failed` only once retries are spent is right, but `self.retry()`
raises Reject when the broker will not take the message, and nothing was written
on that path -- so the version sat at `processing` forever instead.

These exercise the branches directly, including the Reject path, rather than
asserting on a stubbed `self`.
"""
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from celery.exceptions import Reject, Retry

from apps.api.models.asset import ProcessingStatus
from apps.api.tasks import transcode_tasks


def _drive_process_asset(retries: int, retry_raises: BaseException):
    """Run the REAL process_asset body and force its transcode to fail.

    Deliberately not a re-implementation of the except-branch. The previous
    attempt at #271 was reverted partly because its coverage asserted on a
    stubbed `self` rather than on the code that ships, so a test that mirrors
    the branch would repeat that mistake. This patches only the edges -- the
    session, the processor, and retry() -- and lets the real control flow run.
    """
    asset = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4(),
                            asset_type=transcode_tasks.AssetType.video)
    version = SimpleNamespace(id=uuid.uuid4(),
                              processing_status=ProcessingStatus.uploading)
    media_file = SimpleNamespace(version_id=version.id, s3_key_raw="raw/x")

    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.first.side_effect = [version, asset, media_file]

    published = []
    # process_asset is a PromiseProxy until it is resolved; patch the real Task.
    task = transcode_tasks.process_asset
    task = getattr(task, "_get_current_object", lambda: task)()

    # push_request is Celery's own way to set self.request for a direct call.
    # self.request.retries is what the ceiling check reads.
    task.push_request(retries=retries, called_directly=False)
    try:
        with patch.object(transcode_tasks, "SessionLocal", return_value=db), \
             patch.object(transcode_tasks, "get_s3_client", return_value=MagicMock()), \
             patch.object(transcode_tasks, "_process_video",
                          side_effect=RuntimeError("ffmpeg blew up")), \
             patch.object(transcode_tasks, "_publish_event",
                          side_effect=lambda p, t, pl: published.append(t)), \
             patch.object(task, "retry", side_effect=retry_raises) as retry_mock:
            try:
                task.run(str(asset.id), str(version.id))
                outcome = "returned"
            except Retry:
                outcome = "retry_scheduled"
            except Exception:
                outcome = "raised"
            retry_calls = retry_mock.call_count
    finally:
        task.pop_request()

    return SimpleNamespace(version=version, published=published,
                           outcome=outcome, retry_calls=retry_calls)


# ── #271: the status must not oscillate ───────────────────────────────────────

def test_a_scheduled_retry_leaves_the_version_processing():
    """Writing `failed` here made it flap failed -> processing -> failed for the
    whole ladder, while the raw object sat there intact and every reader
    disagreed about the state."""
    r = _drive_process_asset(retries=0, retry_raises=Retry())

    assert r.outcome == "retry_scheduled"
    assert r.version.processing_status == ProcessingStatus.processing
    assert r.published == [], "no failure event while an attempt is still coming"


def test_failed_is_written_once_retries_are_spent():
    r = _drive_process_asset(retries=3, retry_raises=Retry())

    assert r.outcome == "raised"
    assert r.version.processing_status == ProcessingStatus.failed
    assert r.published == ["transcode_failed"]
    assert r.retry_calls == 0, "retrying past the ceiling would raise MaxRetriesExceeded"


def test_a_retry_that_cannot_be_enqueued_records_the_failure():
    """The regression that caused the previous revert.

    self.retry() raises Reject when the broker will not take the message, so no
    further attempt will ever run. Leaving the version at `processing` there is
    what stranded uploads.
    """
    r = _drive_process_asset(retries=0, retry_raises=Reject("broker down", requeue=False))

    assert r.outcome == "raised"
    assert r.version.processing_status == ProcessingStatus.failed
    assert r.published == ["transcode_failed"]


@pytest.mark.parametrize("retries", [0, 1, 2])
def test_attempts_below_the_ceiling_still_retry(retries):
    """Off-by-one guard: one initial attempt plus max_retries."""
    r = _drive_process_asset(retries=retries, retry_raises=Retry())
    assert r.outcome == "retry_scheduled"
    assert r.version.processing_status == ProcessingStatus.processing


# ── #270: a version claimed but never dispatched must be recovered ────────────

def test_the_sweep_is_off_when_the_timeout_is_zero():
    from apps.api.tasks import cleanup_tasks

    with patch.object(cleanup_tasks.settings, "stuck_processing_timeout_hours", 0):
        assert cleanup_tasks.requeue_stuck_processing() == 0


def test_the_sweep_re_dispatches_rather_than_condemning():
    """Marking a stuck version `failed` would be worse than leaving it.

    CompleteMultipartUpload has already run by then, so the raw object is fully
    assembled, and the reaper deletes s3_key_raw for `failed` and `uploading`
    alike. A short broker outage after a large upload would schedule that master
    for deletion. That is why the previous attempt at this was reverted.
    """
    from apps.api.tasks import cleanup_tasks

    stuck = SimpleNamespace(id=uuid.uuid4(), asset_id=uuid.uuid4(),
                            processing_status=ProcessingStatus.processing)
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.all.return_value = [stuck]
    db.first.return_value = None            # no processed output yet

    sent = []
    with patch.object(cleanup_tasks.settings, "stuck_processing_timeout_hours", 6), \
         patch.object(cleanup_tasks, "SessionLocal", return_value=db), \
         patch("apps.api.tasks.celery_app.send_task_safe",
               side_effect=lambda task, *a, **k: sent.append(a)):
        requeued = cleanup_tasks.requeue_stuck_processing()

    assert requeued == 1
    assert sent == [(str(stuck.asset_id), str(stuck.id))]
    # never condemned: the raw object must survive for the retry to use
    assert stuck.processing_status == ProcessingStatus.processing


def test_a_version_whose_output_already_exists_is_marked_ready_not_re_transcoded():
    """Its transcode finished and only the status write was lost. Re-running it
    would redo hours of work to produce the same bytes."""
    from apps.api.tasks import cleanup_tasks

    stuck = SimpleNamespace(id=uuid.uuid4(), asset_id=uuid.uuid4(),
                            processing_status=ProcessingStatus.processing)
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.all.return_value = [stuck]
    db.first.return_value = SimpleNamespace(s3_key_processed="processed/p/a/v")

    sent = []
    with patch.object(cleanup_tasks.settings, "stuck_processing_timeout_hours", 6), \
         patch.object(cleanup_tasks, "SessionLocal", return_value=db), \
         patch("apps.api.tasks.celery_app.send_task_safe",
               side_effect=lambda task, *a, **k: sent.append(a)):
        requeued = cleanup_tasks.requeue_stuck_processing()

    assert requeued == 0
    assert sent == []
    assert stuck.processing_status == ProcessingStatus.ready
