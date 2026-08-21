"""`failed` must mean "this is not coming back", not "an attempt just failed".

process_asset retries three times. Writing `failed` before each retry made the row
oscillate failed -> processing -> failed for the whole ladder, with the raw object
sitting there intact the entire time -- so everything that keys off the status
(/upload/complete's retry guard, the reaper, the client) got a different answer
depending on which second it asked in.
"""
import uuid
from unittest.mock import MagicMock

import pytest

from apps.api.models.asset import AssetType, ProcessingStatus
import apps.api.tasks.transcode_tasks as transcode_module


class _Retry(Exception):
    """Stands in for celery's retry, which raises to abandon the attempt."""


def _run(monkeypatch, retries):
    """Drive process_asset to its except branch with `retries` attempts already spent."""
    version = MagicMock()
    version.id = uuid.uuid4()
    version.processing_status = ProcessingStatus.processing
    asset = MagicMock()
    asset.project_id = uuid.uuid4()
    asset.asset_type = AssetType.video
    media_file = MagicMock()

    session = MagicMock()
    session.query.return_value.filter.return_value.first.side_effect = [
        version, asset, media_file,
    ]
    monkeypatch.setattr(transcode_module, "SessionLocal", lambda: session)
    monkeypatch.setattr(transcode_module, "_publish_event", lambda *a, **k: None)
    monkeypatch.setattr(transcode_module, "get_s3_client", lambda: MagicMock())
    monkeypatch.setattr(
        transcode_module, "_process_video",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("ffmpeg died")),
    )

    task = transcode_module.process_asset
    # `self` on a bind=True task is the task object; its retry count lives on the
    # request stack, which is how celery itself sets it between attempts.
    monkeypatch.setattr(task, "retry", lambda **kw: (_ for _ in ()).throw(_Retry()))
    task.push_request(retries=retries)
    try:
        with pytest.raises(_Retry):
            task.run(str(asset.project_id), str(version.id))
    finally:
        task.pop_request()
    return version


def test_a_version_stays_processing_while_retries_remain(monkeypatch):
    version = _run(monkeypatch, retries=0)
    assert version.processing_status == ProcessingStatus.processing


def test_a_version_is_recorded_failed_once_the_retries_are_spent(monkeypatch):
    version = _run(monkeypatch, retries=3)
    assert version.processing_status == ProcessingStatus.failed
