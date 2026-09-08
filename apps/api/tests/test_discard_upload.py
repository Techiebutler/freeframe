"""Discarding an upload is not the same as one that failed.

A plain abort marks the version `failed`, which is right for a transfer that
gave up and wrong for one somebody threw away on purpose: the asset then carries
a red "Failed" badge in the version switcher for an upload nobody wanted. And
when the object happens to be assembled, abort takes its own branch and
*publishes* it -- so the one control that exists to discard an upload did the
opposite. Found by hand on a dev instance.
"""
import uuid
from unittest.mock import MagicMock

import pytest

import apps.api.routers.upload as upload_module
import apps.api.tasks.cleanup_tasks as cleanup
from apps.api.models.asset import ProcessingStatus

MB = 1024 * 1024
KEY = "raw/p/a/v/original.mp4"


@pytest.fixture
def rows(mock_db, test_user):
    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = uuid.uuid4()
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.uploading
    version.upload_id = "u-1"
    version.deleted_at = None

    media_file = MagicMock()
    media_file.version_id = version.id
    media_file.s3_key_raw = KEY
    media_file.s3_key_processed = None
    media_file.s3_key_thumbnail = None
    media_file.file_size_bytes = 23 * MB
    return version, media_file


def _discard(client, auth_headers, discard=True):
    return client.post(
        "/upload/abort",
        json={
            "s3_key": KEY, "upload_id": "u-1",
            "version_id": str(uuid.uuid4()), "discard": discard,
        },
        headers=auth_headers,
    )


@pytest.fixture
def storage(monkeypatch):
    """Records what the endpoint asked storage to do."""
    calls = {"aborted": [], "deleted": []}
    monkeypatch.setattr(upload_module, "abort_multipart_upload",
                        lambda k, u: calls["aborted"].append((k, u)))
    monkeypatch.setattr(cleanup, "abort_multipart_upload",
                        lambda k, u: calls["aborted"].append((k, u)))
    monkeypatch.setattr(cleanup, "delete_object", lambda k: calls["deleted"].append(k))
    monkeypatch.setattr(cleanup, "delete_prefix", lambda k: calls["deleted"].append(k))
    return calls


def test_a_discarded_upload_leaves_no_version_behind(
    client, auth_headers, mock_db, rows, storage
):
    version, media_file = rows
    # version lookup, then the media files inside the disposal, then the asset
    mock_db.first.side_effect = [version, None, None]
    mock_db.all.return_value = [media_file]

    resp = _discard(client, auth_headers)

    assert resp.status_code == 204
    # Not `failed`: nothing failed. The row is gone.
    assert version.deleted_at is not None
    assert version.processing_status == ProcessingStatus.uploading
    assert KEY in storage["deleted"]


def test_a_discarded_upload_is_never_published(
    client, auth_headers, mock_db, rows, storage, monkeypatch
):
    """Even when the object is already whole.

    The plain abort path asks storage whether the object assembled and promotes
    the version if it did. A discard must not reach that question at all: the
    user asked for this upload to be gone, and whether the bytes happen to be
    complete does not change the answer.
    """
    version, media_file = rows
    mock_db.first.side_effect = [version, None, None]
    mock_db.all.return_value = [media_file]
    dispatched = []
    monkeypatch.setattr(upload_module, "head_object_size", lambda k: 23 * MB)
    monkeypatch.setattr(upload_module, "_trigger_processing",
                        lambda a, v: dispatched.append(v))

    resp = _discard(client, auth_headers)

    assert resp.status_code == 204
    assert dispatched == []
    assert version.processing_status != ProcessingStatus.processing
    assert version.deleted_at is not None


def test_the_flag_cannot_delete_a_version_that_already_landed(
    client, auth_headers, mock_db, rows, storage, monkeypatch
):
    """Otherwise it is a version-delete endpoint by the back door."""
    version, media_file = rows
    version.processing_status = ProcessingStatus.ready
    mock_db.first.side_effect = [version, media_file]

    resp = _discard(client, auth_headers)

    assert resp.status_code == 204
    assert version.deleted_at is None
    assert version.processing_status == ProcessingStatus.ready


def test_without_the_flag_nothing_changes(
    client, auth_headers, mock_db, rows, storage, monkeypatch
):
    """A transfer that gave up is still recorded as failed."""
    version, media_file = rows
    mock_db.first.side_effect = [version, media_file]
    monkeypatch.setattr(upload_module, "head_object_size", lambda k: 0)

    resp = _discard(client, auth_headers, discard=False)

    assert resp.status_code == 204
    assert version.processing_status == ProcessingStatus.failed
    assert version.deleted_at is None
