"""Endpoint-level tests for POST /upload/complete and POST /upload/abort.

Without these the validation helpers are tested but nothing executes the handler,
so the whole "derive the parts list from storage" behaviour can be reverted to
forwarding the client's list with the suite still green.
"""
import uuid
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

import apps.api.routers.upload as upload_module
from apps.api.models.asset import ProcessingStatus

MB = 1024 * 1024

# The asset the uploaded version belongs to. The handler checks the request's
# asset id against the version's, so the rows and the body have to agree on one;
# a test that wants them to disagree overrides `asset_id` on the body.
ASSET_ID = uuid.uuid4()


def _client_error(code: str, op: str = "CompleteMultipartUpload"):
    return ClientError({"Error": {"Code": code, "Message": code}}, op)


@pytest.fixture
def upload_rows(mock_db, test_user):
    """A version being uploaded plus its media file, wired into the mock session."""
    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = ASSET_ID
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.uploading

    media_file = MagicMock()
    media_file.version_id = version.id
    media_file.s3_key_raw = "raw/p/a/v/original.mp4"
    media_file.file_size_bytes = 23 * MB

    mock_db.first.side_effect = [version, media_file]
    return version, media_file


def _body(media_file, **overrides):
    body = {
        "s3_key": media_file.s3_key_raw,
        "upload_id": "upload-1",
        "asset_id": str(ASSET_ID),
        "version_id": str(uuid.uuid4()),
        "parts": [{"PartNumber": 1, "ETag": '"client-said-so"'}],
    }
    body.update(overrides)
    return body


def _listing(*sizes):
    return [
        {"PartNumber": i, "ETag": f'"real-{i}"', "Size": size}
        for i, size in enumerate(sizes, start=1)
    ]


def _stub(monkeypatch, **kwargs):
    """Patch the S3 calls the handler makes, defaulting each to a no-op."""
    completed = {}
    monkeypatch.setattr(
        upload_module, "complete_multipart_upload",
        kwargs.get("complete", lambda k, u, p: completed.update(key=k, parts=p)),
    )
    monkeypatch.setattr(upload_module, "list_upload_parts", kwargs["list_parts"])
    monkeypatch.setattr(
        upload_module, "head_object_size", kwargs.get("head", lambda k: None)
    )
    monkeypatch.setattr(upload_module, "_trigger_processing", lambda a, v: None)
    return completed


# --------------------------------------------------------- request/row agreement

def test_a_completion_naming_another_assets_id_is_rejected(
    client, auth_headers, mock_db, upload_rows, monkeypatch
):
    """The asset id decides where the transcode lands, so it cannot be taken on trust.

    Ownership is proved for the version, never for whatever asset id the body
    carried, and `process_asset` resolves that id with no cross-check of its own:
    the output prefix and the SSE channel are both derived from the asset it
    finds. Without this, the owner of any version can steer their own transcode
    into a project they have no access to.
    """
    version, media_file = upload_rows
    dispatched = []
    listed = []
    # Recorded rather than fatal: a sentinel that raises here would surface as a
    # bare 500 and hide which of the three properties below actually broke.
    _stub(monkeypatch, list_parts=lambda k, u: listed.append(k) or _listing(23 * MB))
    monkeypatch.setattr(upload_module, "_trigger_processing", lambda a, v: dispatched.append(a))

    resp = client.post(
        "/upload/complete",
        json=_body(media_file, asset_id=str(uuid.uuid4())),
        headers=auth_headers,
    )

    assert resp.status_code == 400
    # Rejected before any of the work: no storage call, no rewind, no transcode.
    assert listed == []
    assert version.processing_status == ProcessingStatus.uploading
    assert dispatched == []


def test_a_completion_dispatches_the_versions_own_asset_and_version(
    client, auth_headers, mock_db, upload_rows, monkeypatch
):
    """What the success path hands the transcoder, which nothing else asserts.

    The guard above makes the request's ids and the version's equal, so reverting
    _finish() to read `body.*` passes every other test in this file -- and so does
    swapping the two arguments, which would call process_asset(version_id, asset_id)
    and mis-report the pair to the client. Both are silent. Pinning the order and
    the source here is what makes the guard's promise -- that the dispatch is
    correct on its own, not by way of a check thirty lines above it -- testable.
    """
    version, media_file = upload_rows
    dispatched = []
    _stub(monkeypatch, list_parts=lambda k, u: _listing(23 * MB))
    monkeypatch.setattr(
        upload_module, "_trigger_processing", lambda a, v: dispatched.append((a, v))
    )

    resp = client.post("/upload/complete", json=_body(media_file), headers=auth_headers)

    assert resp.status_code == 200
    assert dispatched == [(version.asset_id, version.id)]
    assert resp.json()["asset_id"] == str(version.asset_id)
    assert resp.json()["version_id"] == str(version.id)


# ------------------------------------------------------------------ the core fix

def test_completes_with_the_parts_storage_holds_not_the_ones_the_client_sent(
    client, auth_headers, mock_db, upload_rows, monkeypatch
):
    _, media_file = upload_rows
    completed = _stub(monkeypatch, list_parts=lambda k, u: _listing(10 * MB, 10 * MB, 3 * MB))

    resp = client.post("/upload/complete", json=_body(media_file), headers=auth_headers)

    assert resp.status_code == 200
    # The client claimed one part with a made-up ETag; storage says three.
    assert completed["parts"] == [
        {"PartNumber": 1, "ETag": '"real-1"'},
        {"PartNumber": 2, "ETag": '"real-2"'},
        {"PartNumber": 3, "ETag": '"real-3"'},
    ]


def test_refuses_to_complete_an_upload_missing_a_part(
    client, auth_headers, mock_db, upload_rows, monkeypatch
):
    """The bug this change exists for: S3 would assemble this and return success."""
    _, media_file = upload_rows
    calls = []
    _stub(
        monkeypatch,
        list_parts=lambda k, u: _listing(10 * MB, 10 * MB),  # 20MB of a declared 23MB
        complete=lambda k, u, p: calls.append(p),
    )

    resp = client.post("/upload/complete", json=_body(media_file), headers=auth_headers)

    assert resp.status_code == 409
    assert "declared" in resp.json()["detail"]
    assert calls == []  # never reached storage


def test_version_is_left_untouched_when_completion_is_refused(
    client, auth_headers, mock_db, upload_rows, monkeypatch
):
    version, media_file = upload_rows
    _stub(monkeypatch, list_parts=lambda k, u: _listing(10 * MB, 10 * MB))

    client.post("/upload/complete", json=_body(media_file), headers=auth_headers)

    assert version.processing_status == ProcessingStatus.uploading


# ------------------------------------------------------------------ replay guard

@pytest.mark.parametrize(
    "status", [ProcessingStatus.processing, ProcessingStatus.ready, ProcessingStatus.failed]
)
def test_replaying_a_finished_upload_is_refused(
    client, auth_headers, mock_db, test_user, monkeypatch, status
):
    """A replay must not rewind a finished version and queue a second transcode.

    `/upload/*` is exempt from the global rate limiter and any unrecognised
    upload id reads as "already gone", so without this guard a loop over this
    endpoint would park the transcoding queue on re-runs of one asset.
    """
    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = ASSET_ID
    version.created_by = test_user.id
    version.processing_status = status

    media_file = MagicMock()
    media_file.s3_key_raw = "raw/p/a/v/original.mp4"
    media_file.file_size_bytes = 23 * MB
    mock_db.first.side_effect = [version, media_file]

    dispatched = []
    monkeypatch.setattr(upload_module, "_trigger_processing", lambda a, v: dispatched.append(v))
    monkeypatch.setattr(upload_module, "list_upload_parts",
                        lambda k, u: pytest.fail("storage must not be touched"))

    resp = client.post(
        "/upload/complete", json=_body(media_file, upload_id="junk"), headers=auth_headers
    )

    assert resp.status_code == 409
    assert version.processing_status == status
    assert dispatched == []


# ------------------------------------------------------------------ idempotency

def test_retry_after_a_lost_response_succeeds_instead_of_failing(
    client, auth_headers, mock_db, upload_rows, monkeypatch
):
    """Completing consumes the upload id; the retry must not leave the version stuck.

    A version left at `uploading` is deleted by the stale-upload reaper a day
    later, so failing here destroys a finished upload.
    """
    version, media_file = upload_rows

    def gone(k, u):
        raise upload_module.MultipartUploadGone(k)

    _stub(monkeypatch, list_parts=gone, head=lambda k: 23 * MB)

    resp = client.post("/upload/complete", json=_body(media_file), headers=auth_headers)

    assert resp.status_code == 200
    assert version.processing_status == ProcessingStatus.processing


def test_a_reaped_upload_is_reported_rather_than_treated_as_done(
    client, auth_headers, mock_db, upload_rows, monkeypatch
):
    version, media_file = upload_rows

    def gone(k, u):
        raise upload_module.MultipartUploadGone(k)

    _stub(monkeypatch, list_parts=gone, head=lambda k: None)

    resp = client.post("/upload/complete", json=_body(media_file), headers=auth_headers)

    assert resp.status_code == 409
    assert "no longer available" in resp.json()["detail"]
    assert version.processing_status == ProcessingStatus.uploading


def test_a_head_object_that_errors_is_not_read_as_success(
    client, auth_headers, mock_db, upload_rows, monkeypatch
):
    """Guessing wrong here either loses a finished upload or reports a missing one done."""
    _, media_file = upload_rows

    def gone(k, u):
        raise upload_module.MultipartUploadGone(k)

    def head_denied(k):
        raise _client_error("AccessDenied", "HeadObject")

    _stub(monkeypatch, list_parts=gone, head=head_denied)

    resp = client.post("/upload/complete", json=_body(media_file), headers=auth_headers)

    assert resp.status_code == 409


# ------------------------------------------------------------------ fallback path

def test_falls_back_to_the_client_list_only_when_listing_is_unsupported(
    client, auth_headers, mock_db, upload_rows, monkeypatch
):
    _, media_file = upload_rows

    def unsupported(k, u):
        raise upload_module.MultipartListingUnsupported("NotImplemented")

    completed = _stub(monkeypatch, list_parts=unsupported)

    resp = client.post("/upload/complete", json=_body(media_file), headers=auth_headers)

    assert resp.status_code == 200
    assert completed["parts"] == [{"PartNumber": 1, "ETag": '"client-said-so"'}]


def test_an_unsupported_backend_with_no_client_parts_is_an_error(
    client, auth_headers, mock_db, upload_rows, monkeypatch
):
    _, media_file = upload_rows

    def unsupported(k, u):
        raise upload_module.MultipartListingUnsupported("NotImplemented")

    _stub(monkeypatch, list_parts=unsupported)

    resp = client.post(
        "/upload/complete", json=_body(media_file, parts=[]), headers=auth_headers
    )
    assert resp.status_code == 400


# ------------------------------------------------------------------ key binding

def test_a_key_that_does_not_belong_to_the_version_is_rejected(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    version = MagicMock()
    version.asset_id = ASSET_ID
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.uploading
    # The MediaFile lookup filters on version_id AND s3_key_raw, so a foreign key misses.
    mock_db.first.side_effect = [version, None]
    monkeypatch.setattr(upload_module, "list_upload_parts",
                        lambda k, u: pytest.fail("storage must not be touched"))

    resp = client.post(
        "/upload/complete",
        json={
            "s3_key": "raw/someone/else/original.mp4",
            "upload_id": "u",
            "asset_id": str(ASSET_ID),
            "version_id": str(uuid.uuid4()),
            "parts": [],
        },
        headers=auth_headers,
    )
    assert resp.status_code == 404


# ------------------------------------------------------------------ abort

def test_abort_marks_the_version_failed_when_the_upload_was_already_gone(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    version = MagicMock()
    version.id = uuid.uuid4()
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.uploading
    media_file = MagicMock()
    media_file.s3_key_raw = "raw/k"
    media_file.file_size_bytes = 23 * MB
    # Second lookup: abort now asks whether the object actually got assembled before
    # deciding this upload failed.
    mock_db.first.side_effect = [version, media_file]

    def already_gone(k, u):
        raise _client_error("NoSuchUpload", "AbortMultipartUpload")

    monkeypatch.setattr(upload_module, "abort_multipart_upload", already_gone)
    monkeypatch.setattr(upload_module, "head_object_size", lambda k: None)

    resp = client.post(
        "/upload/abort",
        json={"s3_key": "raw/k", "upload_id": "u", "version_id": str(uuid.uuid4())},
        headers=auth_headers,
    )

    assert resp.status_code == 204
    assert version.processing_status == ProcessingStatus.failed


def test_abort_does_not_fail_a_version_that_already_finished(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    """The client aborts from the catch of every completion failure.

    A lost response to a *successful* complete would otherwise mark a finished,
    transcoded version failed, and the reaper deletes those a day later.
    """
    version = MagicMock()
    version.id = uuid.uuid4()
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.ready
    mock_db.first.side_effect = [version]
    monkeypatch.setattr(upload_module, "abort_multipart_upload", lambda k, u: None)

    resp = client.post(
        "/upload/abort",
        json={"s3_key": "raw/k", "upload_id": "u", "version_id": str(uuid.uuid4())},
        headers=auth_headers,
    )

    assert resp.status_code == 204
    assert version.processing_status == ProcessingStatus.ready


def test_abort_surfaces_a_real_storage_failure(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    """Swallowing this would leave parts in the bucket and tell nobody."""
    version = MagicMock()
    version.id = uuid.uuid4()
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.uploading
    mock_db.first.side_effect = [version]

    def denied(k, u):
        raise _client_error("AccessDenied", "AbortMultipartUpload")

    monkeypatch.setattr(upload_module, "abort_multipart_upload", denied)

    resp = client.post(
        "/upload/abort",
        json={"s3_key": "raw/k", "upload_id": "u", "version_id": str(uuid.uuid4())},
        headers=auth_headers,
    )

    # Not a 204: the parts are still in the bucket, and saying "aborted" would
    # hide that. The version keeps its status rather than being marked failed on
    # the strength of a cleanup that did not happen.
    assert resp.status_code >= 500
    assert version.processing_status == ProcessingStatus.uploading
