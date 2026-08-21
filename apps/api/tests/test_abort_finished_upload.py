"""`/upload/abort` must not fail a version whose upload actually completed.

`CompleteMultipartUpload` can succeed with the process dying before the status is
committed. That leaves a fully assembled object and a version still reading
`uploading`. The client fires abort from the catch of every completion failure, so
without a check the version is marked failed and the stale-upload reaper deletes
the finished file a day later.
"""
import uuid
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

import apps.api.routers.upload as upload_module
from apps.api.models.asset import ProcessingStatus

MB = 1024 * 1024
KEY = "raw/p/a/v/original.mp4"


def _client_error(code: str, op: str = "AbortMultipartUpload"):
    return ClientError({"Error": {"Code": code, "Message": code}}, op)


@pytest.fixture
def abort_rows(mock_db, test_user):
    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = uuid.uuid4()
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.uploading

    media_file = MagicMock()
    media_file.version_id = version.id
    media_file.s3_key_raw = KEY
    media_file.file_size_bytes = 23 * MB

    # version lookup, then (only on the uploading path) the media file lookup
    mock_db.first.side_effect = [version, media_file]
    return version, media_file


def _abort(client, auth_headers):
    return client.post(
        "/upload/abort",
        json={"s3_key": KEY, "upload_id": "u-1", "version_id": str(uuid.uuid4())},
        headers=auth_headers,
    )


def test_a_completed_upload_is_recorded_as_processing_not_failed(
    client, auth_headers, mock_db, abort_rows, monkeypatch
):
    """The whole point: the object is there, so this upload did not fail."""
    version, _ = abort_rows
    dispatched = []
    monkeypatch.setattr(upload_module, "abort_multipart_upload",
                        lambda k, u: (_ for _ in ()).throw(_client_error("NoSuchUpload")))
    monkeypatch.setattr(upload_module, "head_object_size", lambda k: 23 * MB)
    monkeypatch.setattr(upload_module, "_trigger_processing", lambda a, v: dispatched.append(v))

    assert _abort(client, auth_headers).status_code == 204
    assert version.processing_status == ProcessingStatus.processing
    # It never got its transcode dispatched either, so do that now.
    assert dispatched == [version.id]


def test_a_genuinely_cancelled_upload_still_fails(
    client, auth_headers, mock_db, abort_rows, monkeypatch
):
    """The ordinary case: nothing at the key, so this really did fail."""
    version, _ = abort_rows
    monkeypatch.setattr(upload_module, "abort_multipart_upload", lambda k, u: None)
    monkeypatch.setattr(upload_module, "head_object_size", lambda k: None)
    monkeypatch.setattr(upload_module, "_trigger_processing",
                        lambda a, v: pytest.fail("nothing to process"))

    assert _abort(client, auth_headers).status_code == 204
    assert version.processing_status == ProcessingStatus.failed


def test_a_partial_object_at_the_key_is_not_mistaken_for_success(
    client, auth_headers, mock_db, abort_rows, monkeypatch
):
    """Size is the check, not mere existence."""
    version, _ = abort_rows
    monkeypatch.setattr(upload_module, "abort_multipart_upload", lambda k, u: None)
    monkeypatch.setattr(upload_module, "head_object_size", lambda k: 10 * MB)

    assert _abort(client, auth_headers).status_code == 204
    assert version.processing_status == ProcessingStatus.failed


def test_an_unreadable_head_object_does_not_claim_success(
    client, auth_headers, mock_db, abort_rows, monkeypatch
):
    """Guessing wrong in this direction would report a missing upload as done."""
    version, _ = abort_rows
    monkeypatch.setattr(upload_module, "abort_multipart_upload", lambda k, u: None)
    monkeypatch.setattr(upload_module, "head_object_size",
                        lambda k: (_ for _ in ()).throw(_client_error("AccessDenied", "HeadObject")))

    assert _abort(client, auth_headers).status_code == 204
    assert version.processing_status == ProcessingStatus.failed


def test_a_version_that_already_reached_processing_is_left_alone(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    version = MagicMock()
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.processing
    mock_db.first.side_effect = [version]
    monkeypatch.setattr(upload_module, "abort_multipart_upload", lambda k, u: None)
    monkeypatch.setattr(upload_module, "head_object_size",
                        lambda k: pytest.fail("must not even ask"))

    assert _abort(client, auth_headers).status_code == 204
    assert version.processing_status == ProcessingStatus.processing


def test_a_real_storage_failure_is_still_surfaced(
    client, auth_headers, mock_db, abort_rows, monkeypatch
):
    """Parts are still in the bucket; reporting success would hide that."""
    version, _ = abort_rows
    monkeypatch.setattr(upload_module, "abort_multipart_upload",
                        lambda k, u: (_ for _ in ()).throw(_client_error("AccessDenied")))

    assert _abort(client, auth_headers).status_code >= 500
    assert version.processing_status == ProcessingStatus.uploading
