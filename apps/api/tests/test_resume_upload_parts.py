"""Tests for GET /upload/{version_id}/parts, which is what makes a resume possible.

The endpoint answers "what does the backend already hold for this upload", so the
client can send the rest instead of the lot. Two properties carry the weight:
a part only counts as held when its *size* matches what this upload cuts parts
at, and the chunk size the client is told to use comes from the server rather
than from its own constant.
"""
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

import apps.api.routers.upload as upload_module
from apps.api.models.asset import ProcessingStatus
from apps.api.routers.upload import _held_part_numbers, _pinned_chunk_size
from apps.api.schemas.upload import CHUNK_SIZE_BYTES
from apps.api.services.s3_service import (
    MultipartListingUnsupported, MultipartUploadGone,
)

MB = 1024 * 1024
CHUNK = 10 * MB
# 23 MB is two full parts and a 3 MB remainder, so the final part is a different
# size from its siblings -- which is the case a uniform size check gets wrong.
TOTAL = 23 * MB
ASSET_ID = uuid.uuid4()


def _listing(*pairs) -> list[dict]:
    """(part number, size) pairs as ListParts reports them."""
    return [
        {"PartNumber": number, "ETag": f'"etag-{number}"', "Size": size}
        for number, size in pairs
    ]


# ------------------------------------------------------------- which parts count

def test_a_full_size_part_counts_as_held():
    assert _held_part_numbers(_listing((1, CHUNK), (2, CHUNK)), CHUNK, TOTAL) == [1, 2]


def test_the_final_part_counts_at_its_own_shorter_size():
    # The remainder is not a chunk, and comparing it against one would make the
    # last part of every upload look missing forever.
    assert _held_part_numbers(_listing((3, 3 * MB)), CHUNK, TOTAL) == [3]


def test_a_short_part_does_not_count():
    # A PUT that was cut off mid-body. S3 accepts it and lists it; completing
    # with it assembles a file with a hole in the middle.
    assert _held_part_numbers(_listing((1, CHUNK), (2, 4 * MB)), CHUNK, TOTAL) == [1]


def test_holes_are_reported_as_holes_rather_than_closed_up():
    # Parts arrive out of order once several are in flight, so what is held is a
    # set and not a prefix. Returning [1, 2] here would re-send a part that is
    # already there and, worse, imply part 3 needs sending when it does not.
    assert _held_part_numbers(_listing((1, CHUNK), (3, 3 * MB)), CHUNK, TOTAL) == [1, 3]


def test_a_part_number_past_the_end_of_the_file_does_not_count():
    # A leftover from an upload of a different length against the same key.
    assert _held_part_numbers(_listing((1, CHUNK), (9, CHUNK)), CHUNK, TOTAL) == [1]


def test_a_part_listed_twice_does_not_count():
    # SeaweedFS keeps both writes of a retried part. Choosing between them needs
    # the ETag comparison this deliberately does not rely on.
    assert _held_part_numbers(_listing((1, CHUNK), (1, CHUNK)), CHUNK, TOTAL) == []


def test_a_part_with_no_reported_size_does_not_count():
    assert _held_part_numbers([{"PartNumber": 1, "ETag": '"a"', "Size": None}], CHUNK, TOTAL) == []


# ------------------------------------------------------------ which chunk size

def test_the_recorded_chunk_size_wins():
    version = SimpleNamespace(chunk_size_bytes=8 * MB)
    assert _pinned_chunk_size(version, _listing((1, CHUNK), (2, CHUNK))) == 8 * MB


def test_an_unrecorded_chunk_size_is_read_back_from_the_parts_held():
    # Rows predating the column. A part whose number is below another held part's
    # cannot be the final one, so its size is a whole chunk.
    version = SimpleNamespace(chunk_size_bytes=None)
    assert _pinned_chunk_size(version, _listing((1, 8 * MB), (2, 3 * MB))) == 8 * MB


def test_an_unrecorded_chunk_size_falls_back_to_the_constant_when_nothing_is_held():
    version = SimpleNamespace(chunk_size_bytes=None)
    assert _pinned_chunk_size(version, []) == CHUNK_SIZE_BYTES
    assert _pinned_chunk_size(version, _listing((1, 5 * MB))) == CHUNK_SIZE_BYTES


# ---------------------------------------------------------------- the endpoint

@pytest.fixture
def resumable(mock_db, test_user):
    """A version still uploading, its media file, and both wired into the session."""
    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = ASSET_ID
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.uploading
    version.upload_id = "upload-1"
    version.chunk_size_bytes = CHUNK
    version.last_activity_at = None

    media_file = MagicMock()
    media_file.version_id = version.id
    media_file.s3_key_raw = "raw/p/a/v/original.mp4"
    media_file.file_size_bytes = TOTAL
    media_file.original_filename = "clip.mp4"
    media_file.mime_type = "video/mp4"

    mock_db.first.side_effect = [version, media_file]
    return version, media_file


def _url(version) -> str:
    return f"/upload/{version.id}/parts"


def test_it_reports_the_parts_held_and_the_pinned_chunk_size(
    client, auth_headers, resumable, monkeypatch
):
    version, _ = resumable
    monkeypatch.setattr(
        upload_module, "list_upload_parts",
        lambda k, u: _listing((1, CHUNK), (2, CHUNK)),
    )

    resp = client.get(_url(version), headers=auth_headers)

    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "resumable"
    assert body["held_part_numbers"] == [1, 2]
    assert body["chunk_size_bytes"] == CHUNK
    assert body["file_size_bytes"] == TOTAL
    # The client needs these to keep uploading and has no way to have kept them
    # across a closed tab.
    assert body["upload_id"] == "upload-1"
    assert body["s3_key"] == "raw/p/a/v/original.mp4"
    assert body["original_filename"] == "clip.mp4"


def test_asking_to_resume_counts_as_activity(client, auth_headers, resumable, monkeypatch):
    # Otherwise a resume started just inside the reaper's window races it, and the
    # reaper aborts the upload underneath the transfer it just handed out.
    version, _ = resumable
    monkeypatch.setattr(upload_module, "list_upload_parts", lambda k, u: [])

    client.get(_url(version), headers=auth_headers)

    assert version.last_activity_at is not None


def test_a_backend_without_listparts_resumes_with_nothing_held(
    client, auth_headers, resumable, monkeypatch
):
    # Every part is sent again, into the same multipart upload. That saves
    # nothing, but it completes -- which is better than refusing to run at all on
    # a backend whose only sin is not implementing ListParts.
    version, _ = resumable

    def _unsupported(key, upload_id):
        raise MultipartListingUnsupported("NotImplemented")

    monkeypatch.setattr(upload_module, "list_upload_parts", _unsupported)

    resp = client.get(_url(version), headers=auth_headers)

    assert resp.status_code == 200
    assert resp.json()["state"] == "resumable"
    assert resp.json()["held_part_numbers"] == []


def test_an_already_assembled_object_is_reported_as_assembled(
    client, auth_headers, resumable, monkeypatch
):
    # CompleteMultipartUpload ran and the status write did not. There is nothing
    # to upload; the client finishes by retrying the completion.
    version, _ = resumable

    def _gone(key, upload_id):
        raise MultipartUploadGone(key)

    monkeypatch.setattr(upload_module, "list_upload_parts", _gone)
    monkeypatch.setattr(upload_module, "head_object_size", lambda k: TOTAL)

    resp = client.get(_url(version), headers=auth_headers)

    assert resp.status_code == 200
    assert resp.json()["state"] == "assembled"
    assert resp.json()["held_part_numbers"] == []


def test_a_reaped_upload_is_reported_as_gone(client, auth_headers, resumable, monkeypatch):
    version, _ = resumable

    def _gone(key, upload_id):
        raise MultipartUploadGone(key)

    monkeypatch.setattr(upload_module, "list_upload_parts", _gone)
    monkeypatch.setattr(upload_module, "head_object_size", lambda k: None)

    resp = client.get(_url(version), headers=auth_headers)

    assert resp.status_code == 409
    assert "no longer available" in resp.json()["detail"]


def test_storage_that_cannot_be_reached_is_not_reported_as_gone(
    client, auth_headers, resumable, monkeypatch
):
    # "Could not find out" must never become "upload the whole file again". This
    # is the same distinction /upload/complete makes, and for the same reason.
    version, _ = resumable

    def _blip(key, upload_id):
        raise EndpointConnectionError(endpoint_url="http://storage")

    monkeypatch.setattr(upload_module, "list_upload_parts", _blip)

    resp = client.get(_url(version), headers=auth_headers)

    assert resp.status_code == 503


def test_an_unreachable_head_during_a_gone_upload_is_not_reported_as_gone(
    client, auth_headers, resumable, monkeypatch
):
    version, _ = resumable

    def _gone(key, upload_id):
        raise MultipartUploadGone(key)

    def _blip(key):
        raise EndpointConnectionError(endpoint_url="http://storage")

    monkeypatch.setattr(upload_module, "list_upload_parts", _gone)
    monkeypatch.setattr(upload_module, "head_object_size", _blip)

    resp = client.get(_url(version), headers=auth_headers)

    assert resp.status_code == 503


def test_a_version_that_is_no_longer_uploading_has_nothing_to_resume(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    version = MagicMock()
    version.id = uuid.uuid4()
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.processing
    mock_db.first.side_effect = [version]
    listed = []
    monkeypatch.setattr(
        upload_module, "list_upload_parts", lambda k, u: listed.append(k) or []
    )

    resp = client.get(_url(version), headers=auth_headers)

    assert resp.status_code == 409
    assert "already processing" in resp.json()["detail"]
    assert listed == []


def test_another_users_upload_cannot_be_inspected(
    client, auth_headers, mock_db, monkeypatch
):
    # The response carries the key and the upload id, which together are enough
    # to write into somebody else's object.
    version = MagicMock()
    version.id = uuid.uuid4()
    version.created_by = uuid.uuid4()
    version.processing_status = ProcessingStatus.uploading
    mock_db.first.side_effect = [version]
    listed = []
    monkeypatch.setattr(
        upload_module, "list_upload_parts", lambda k, u: listed.append(k) or []
    )

    resp = client.get(_url(version), headers=auth_headers)

    assert resp.status_code == 403
    assert listed == []


def test_a_version_with_no_recorded_upload_id_cannot_be_resumed(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    # Rows predating upload ids being stored. Nothing can name the multipart
    # upload they belong to, and a bucket scan is not an alternative: MinIO reads
    # ListMultipartUploads from a node-local cache that a restart empties.
    version = MagicMock()
    version.id = uuid.uuid4()
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.uploading
    version.upload_id = None

    media_file = MagicMock()
    media_file.s3_key_raw = "raw/p/a/v/original.mp4"
    media_file.file_size_bytes = TOTAL
    mock_db.first.side_effect = [version, media_file]

    resp = client.get(_url(version), headers=auth_headers)

    assert resp.status_code == 409
    assert "cannot be resumed" in resp.json()["detail"]


def test_initiate_tells_the_client_which_chunk_size_to_use(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    """The constant was dead code, so the client's own was the only one in play."""
    monkeypatch.setattr(upload_module, "upload_guard_error", lambda db, size: None)
    monkeypatch.setattr(upload_module, "require_project_role", lambda *a, **k: None)
    monkeypatch.setattr(upload_module, "create_multipart_upload", lambda k, m: "upload-1")

    project = MagicMock()
    project_id = uuid.uuid4()
    # project lookup, then the last-version lookup (none: this is version 1).
    mock_db.first.side_effect = [project, None]

    recorded = []

    def _add(obj):
        # The rows get their identity from the database on add+flush.
        if getattr(obj, "id", None) is None:
            obj.id = uuid.uuid4()
        recorded.append(obj)

    mock_db.add.side_effect = _add

    resp = client.post(
        "/upload/initiate",
        json={
            "project_id": str(project_id),
            "asset_name": "clip",
            "original_filename": "clip.mp4",
            "mime_type": "video/mp4",
            "file_size_bytes": TOTAL,
        },
        headers=auth_headers,
    )

    assert resp.status_code == 200
    assert resp.json()["chunk_size_bytes"] == CHUNK_SIZE_BYTES
    # And pinned to the row, so a later release changing the constant cannot move
    # the byte ranges of an upload that is already in flight.
    versions = [o for o in recorded if hasattr(o, "version_number")]
    assert versions and versions[0].chunk_size_bytes == CHUNK_SIZE_BYTES
