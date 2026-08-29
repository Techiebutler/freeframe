"""Endpoint-level tests for POST /upload/complete and POST /upload/abort.

Without these the validation helpers are tested but nothing executes the handler,
so the whole "derive the parts list from storage" behaviour can be reverted to
forwarding the client's list with the suite still green.
"""
import uuid
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import (
    ClientError, ConnectTimeoutError, EndpointConnectionError, ReadTimeoutError,
)

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
    # Nothing assembled at the key, so this is a replay rather than a retry of a
    # request that already succeeded -- see the test below for that case.
    monkeypatch.setattr(upload_module, "head_object_size", lambda k: None)

    resp = client.post(
        "/upload/complete", json=_body(media_file, upload_id="junk"), headers=auth_headers
    )

    assert resp.status_code == 409
    assert version.processing_status == status
    assert dispatched == []


@pytest.mark.parametrize("status", [ProcessingStatus.processing, ProcessingStatus.ready])
def test_retry_against_a_finished_version_reports_success_not_conflict(
    client, auth_headers, mock_db, test_user, monkeypatch, status
):
    """A completion whose response was lost must not be reported as a failure.

    The first call commits `processing` and then the response never arrives --
    a dropped connection, a closed laptop, a proxy timeout. The client retries the
    same request and lands on the guard above. Answering 409 tells a user whose
    upload worked that it failed, and the client fires /upload/abort from the catch
    of every completion failure, so the report is not inert either.

    Storage settles it: the assembled object is there at the declared size, so this
    request already succeeded.
    """
    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = ASSET_ID
    version.created_by = test_user.id
    version.processing_status = status
    # A retry presents the upload id it was handed at initiate. That is what makes
    # it a retry rather than a replay, and the guard now checks it.
    version.upload_id = "upload-1"

    media_file = MagicMock()
    media_file.s3_key_raw = "raw/p/a/v/original.mp4"
    media_file.file_size_bytes = 23 * MB
    mock_db.first.side_effect = [version, media_file]

    dispatched = []
    monkeypatch.setattr(upload_module, "_trigger_processing", lambda a, v: dispatched.append(v))
    monkeypatch.setattr(upload_module, "list_upload_parts",
                        lambda k, u: pytest.fail("storage listing must not be touched"))
    monkeypatch.setattr(upload_module, "head_object_size", lambda k: 23 * MB)

    resp = client.post(
        "/upload/complete", json=_body(media_file), headers=auth_headers
    )

    assert resp.status_code == 200
    # The version's own status, so one that has since gone `ready` does not read
    # as still transcoding.
    assert resp.json()["status"] == status.value
    # The expensive half of the guard is unchanged: no rewind, no second transcode.
    assert version.processing_status == status
    assert dispatched == []


def test_retry_against_a_failed_version_is_still_refused(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    """`failed` is a version somebody resolved as broken, not a completion.

    An object sitting at the key must not turn that into a success -- that would
    paper over the disagreement instead of surfacing it.
    """
    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = ASSET_ID
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.failed
    # Must match the body, or the upload-id check refuses it first and the
    # carve-out below is never exercised.
    version.upload_id = "upload-1"

    media_file = MagicMock()
    media_file.s3_key_raw = "raw/p/a/v/original.mp4"
    media_file.file_size_bytes = 23 * MB
    mock_db.first.side_effect = [version, media_file]

    looked = []
    monkeypatch.setattr(upload_module, "head_object_size",
                        lambda k: looked.append(k) or 23 * MB)
    monkeypatch.setattr(upload_module, "list_upload_parts",
                        lambda k, u: pytest.fail("storage listing must not be touched"))

    resp = client.post("/upload/complete", json=_body(media_file), headers=auth_headers)

    assert resp.status_code == 409
    # The carve-out, not the upload-id check, which this request satisfies. `failed`
    # is refused without asking storage at all -- so adding it to `completed_before`
    # makes the HeadObject run, find 23MB, and answer 200 instead.
    assert looked == []


def test_retry_with_a_short_object_at_the_key_is_refused(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    """A half-assembled object is not proof the completion ran."""
    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = ASSET_ID
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.processing
    version.upload_id = "upload-1"

    media_file = MagicMock()
    media_file.s3_key_raw = "raw/p/a/v/original.mp4"
    media_file.file_size_bytes = 23 * MB
    mock_db.first.side_effect = [version, media_file]

    monkeypatch.setattr(upload_module, "head_object_size", lambda k: 10 * MB)
    monkeypatch.setattr(upload_module, "list_upload_parts",
                        lambda k, u: pytest.fail("storage listing must not be touched"))

    resp = client.post(
        "/upload/complete", json=_body(media_file, upload_id="junk"), headers=auth_headers
    )

    assert resp.status_code == 409


@pytest.mark.parametrize("blip", [
    EndpointConnectionError(endpoint_url="http://storage:9000"),
    ConnectTimeoutError(endpoint_url="http://storage:9000"),
    ReadTimeoutError(endpoint_url="http://storage:9000"),
])
def test_retry_survives_a_storage_blip_as_a_conflict_not_a_crash(
    client, auth_headers, mock_db, test_user, monkeypatch, blip
):
    """Storage being briefly unreachable must degrade to the old answer, not to a 500.

    These are `BotoCoreError`s, not `ClientError`s -- never reaching the backend is a
    different class from being refused by it. The check above now runs on the common
    retry path, so an uncaught one would surface as an unhandled 500 exactly when a
    user's upload is fine, and the client fires /upload/abort from the catch of any
    completion failure, 500 included.

    A HeadObject we could not complete says nothing either way -- which is not the
    same as saying the object is not there. 409 would tell the client the request
    can never succeed, and ours treats that as final: it marks the upload failed and
    fires /upload/abort. A blip must leave the door open instead.
    """
    def _blip(_key):
        raise blip

    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = ASSET_ID
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.processing
    version.upload_id = "upload-1"

    media_file = MagicMock()
    media_file.s3_key_raw = "raw/p/a/v/original.mp4"
    media_file.file_size_bytes = 23 * MB
    mock_db.first.side_effect = [version, media_file]

    dispatched = []
    monkeypatch.setattr(upload_module, "_trigger_processing", lambda a, v: dispatched.append(v))
    monkeypatch.setattr(upload_module, "list_upload_parts",
                        lambda k, u: pytest.fail("storage listing must not be touched"))
    monkeypatch.setattr(upload_module, "head_object_size", _blip)

    resp = client.post(
        "/upload/complete", json=_body(media_file), headers=auth_headers
    )

    assert resp.status_code == 503
    assert resp.headers["Retry-After"] == "5"
    assert version.processing_status == ProcessingStatus.processing
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


def test_a_head_object_that_errors_is_retryable_rather_than_a_conflict(
    client, auth_headers, mock_db, upload_rows, monkeypatch
):
    """Guessing wrong here either loses a finished upload or reports a missing one done.

    So it guesses neither. A 409 would tell the client to upload the whole file
    again -- and this client treats 409 as final -- when the object may be sitting
    complete at the key and only the lookup failed.
    """
    _, media_file = upload_rows

    def gone(k, u):
        raise upload_module.MultipartUploadGone(k)

    def head_denied(k):
        raise _client_error("AccessDenied", "HeadObject")

    _stub(monkeypatch, list_parts=gone, head=head_denied)

    resp = client.post("/upload/complete", json=_body(media_file), headers=auth_headers)

    assert resp.status_code == 503
    assert resp.headers["Retry-After"] == "5"


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
    version.asset_id = ASSET_ID
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
    version.asset_id = ASSET_ID
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
    version.asset_id = ASSET_ID
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


# ------------------------------------------------- retry vs replay, and blips

def test_a_replay_with_an_unrecognised_upload_id_never_reaches_storage(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    """The upload id separates a retry from a replay without asking storage.

    A retry presents the id it was handed at initiate; a replay presents whatever
    it has. The version records its own, so the two are distinguishable from stored
    state alone -- which keeps the replay path free of network I/O on the one
    endpoint family the global rate limiter exempts.
    """
    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = ASSET_ID
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.processing
    version.upload_id = "upload-1"

    media_file = MagicMock()
    media_file.s3_key_raw = "raw/p/a/v/original.mp4"
    media_file.file_size_bytes = 23 * MB
    mock_db.first.side_effect = [version, media_file]

    looked = []
    monkeypatch.setattr(upload_module, "head_object_size", lambda k: looked.append(k) or 23 * MB)
    monkeypatch.setattr(upload_module, "list_upload_parts", lambda k, u: looked.append(k) or [])
    monkeypatch.setattr(upload_module, "_trigger_processing", lambda a, v: looked.append(v))

    resp = client.post(
        "/upload/complete", json=_body(media_file, upload_id="junk"), headers=auth_headers
    )

    assert resp.status_code == 409
    assert looked == []
    assert version.processing_status == ProcessingStatus.processing


def test_a_storage_failure_listing_parts_is_retryable_not_a_crash(
    client, auth_headers, mock_db, upload_rows, monkeypatch
):
    """This runs on every genuine completion, not only on a retry.

    It had no handling at all, so a transient SlowDown at the end of a multi-hour
    transfer escaped as a 500. The client answers any completion failure with
    /upload/abort, which correctly reports not-assembled because
    CompleteMultipartUpload never ran, commits `failed`, and the reaper then deletes
    a file that transferred perfectly.
    """
    version, media_file = upload_rows
    dispatched = []

    def throttled(k, u):
        raise _client_error("SlowDown", "ListParts")

    _stub(monkeypatch, list_parts=throttled)
    monkeypatch.setattr(upload_module, "_trigger_processing", lambda a, v: dispatched.append(v))

    resp = client.post("/upload/complete", json=_body(media_file), headers=auth_headers)

    assert resp.status_code == 503
    assert resp.headers["Retry-After"] == "5"
    # Nothing was decided, so nothing was written and nothing was queued.
    assert version.processing_status == ProcessingStatus.uploading
    assert dispatched == []


def test_a_completion_that_did_not_answer_is_accepted_once_the_object_is_there(
    client, auth_headers, mock_db, upload_rows, monkeypatch
):
    """CompleteMultipartUpload is the longest call here and can time out having worked."""
    version, media_file = upload_rows
    dispatched = []

    def timed_out(k, u, p):
        raise ReadTimeoutError(endpoint_url="http://storage:9000")

    _stub(
        monkeypatch,
        list_parts=lambda k, u: _listing(23 * MB),
        complete=timed_out,
        head=lambda k: 23 * MB,
    )
    monkeypatch.setattr(upload_module, "_trigger_processing", lambda a, v: dispatched.append(v))

    resp = client.post("/upload/complete", json=_body(media_file), headers=auth_headers)

    assert resp.status_code == 200
    assert version.processing_status == ProcessingStatus.processing
    assert dispatched == [version.id]




# ── the completion claim gates the dispatch (#272) ────────────────────────────

def test_a_completion_that_does_not_claim_the_version_does_not_dispatch(
    client, mock_db, upload_rows, auth_headers, monkeypatch
):
    """Two concurrent completions can both pass the status check above.

    The loser must not dispatch: two transcodes writing the same processed/
    prefix at once is the whole point of the claim. Here the claim reports zero
    rows updated, which is what Postgres returns for the loser.
    """
    version, media_file = upload_rows
    dispatched = []
    # _stub() patches _trigger_processing to a no-op, so capture it afterwards or
    # this test passes no matter what the handler does.
    _stub(monkeypatch, list_parts=lambda k, u: _listing(23 * MB))
    monkeypatch.setattr(upload_module, "_trigger_processing",
                        lambda a, v: dispatched.append(v))
    mock_db.update.return_value = 0          # someone else claimed it first

    resp = client.post("/upload/complete", json=_body(media_file), headers=auth_headers)

    assert resp.status_code == 200, resp.text
    # the caller is still told the work is underway, because it is
    assert resp.json()["status"] == "processing"
    assert dispatched == [], "the losing completion must not queue a second transcode"


def test_a_completion_that_claims_the_version_dispatches_once(
    client, mock_db, upload_rows, auth_headers, monkeypatch
):
    version, media_file = upload_rows
    dispatched = []
    _stub(monkeypatch, list_parts=lambda k, u: _listing(23 * MB))
    monkeypatch.setattr(upload_module, "_trigger_processing",
                        lambda a, v: dispatched.append(v))
    mock_db.update.return_value = 1          # this request won the row

    resp = client.post("/upload/complete", json=_body(media_file), headers=auth_headers)

    assert resp.status_code == 200, resp.text
    assert dispatched == [version.id]
