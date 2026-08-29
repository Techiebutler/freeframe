import logging
import os
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, status, BackgroundTasks
from sqlalchemy.orm import Session
import uuid
from datetime import datetime, timezone
from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.asset import Asset, AssetVersion, MediaFile, AssetType, ProcessingStatus, FileType
from ..models.folder import Folder
from ..models.project import Project
from ..services.s3_service import (
    ObjectSizeUnavailable,
    create_multipart_upload, presign_upload_part,
    complete_multipart_upload, abort_multipart_upload,
    list_upload_parts, head_object_size, UPLOAD_GONE_CODES,
    MultipartUploadGone, MultipartListingUnsupported,
)
from ..services.permissions import get_project_member, require_project_role
from ..models.project import ProjectRole
from ..schemas.upload import (
    InitiateUploadRequest, InitiateUploadResponse,
    PresignPartRequest, PresignPartResponse,
    CompleteUploadRequest, CompleteUploadResponse, AbortUploadRequest,
    ALLOWED_MIME_TYPES, mime_to_asset_type,
)
from ..services.storage import upload_guard_error

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/upload", tags=["upload"])

@router.post("/initiate", response_model=InitiateUploadResponse)
def initiate_upload(
    body: InitiateUploadRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Validate mime type
    if body.mime_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {body.mime_type}")
    guard_error = upload_guard_error(db, body.file_size_bytes)
    if guard_error:
        raise HTTPException(status_code=400, detail=guard_error)

    # Verify project access (editor or above)
    project = db.query(Project).filter(Project.id == body.project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_role(db, body.project_id, current_user, ProjectRole.editor)

    # Get or create asset
    if body.asset_id:
        asset = db.query(Asset).filter(Asset.id == body.asset_id, Asset.deleted_at.is_(None)).first()
        if not asset:
            raise HTTPException(status_code=404, detail="Asset not found")
        if asset.project_id != body.project_id:
            raise HTTPException(status_code=400, detail="Asset does not belong to the specified project")
    else:
        # Validate the target folder for a new asset: it must exist, belong to this project, and not
        # be soft-deleted -- otherwise a live asset could be placed under a trashed folder and later
        # hard-deleted by the retention GC's folder cascade. folder_id is only persisted here (new
        # asset); the new-version path above ignores it, so it must not be validated there.
        if body.folder_id is not None:
            folder = db.query(Folder).filter(
                Folder.id == body.folder_id,
                Folder.project_id == body.project_id,
                Folder.deleted_at.is_(None),
            ).first()
            if not folder:
                raise HTTPException(status_code=404, detail="Folder not found")

        asset_type = mime_to_asset_type(body.mime_type)
        asset = Asset(
            project_id=body.project_id,
            name=body.asset_name,
            asset_type=asset_type,
            created_by=current_user.id,
            folder_id=body.folder_id,
        )
        db.add(asset)
        db.flush()

    # Get next version number
    last_version = db.query(AssetVersion).filter(
        AssetVersion.asset_id == asset.id,
        AssetVersion.deleted_at.is_(None),
    ).order_by(AssetVersion.version_number.desc()).first()
    next_version_number = (last_version.version_number + 1) if last_version else 1

    # Build S3 key: raw/{project_id}/{asset_id}/{version_id}/{filename}
    version = AssetVersion(
        asset_id=asset.id,
        version_number=next_version_number,
        processing_status=ProcessingStatus.uploading,
        created_by=current_user.id,
    )
    db.add(version)
    db.flush()

    ext = os.path.splitext(body.original_filename)[1].lower()
    s3_key = f"raw/{body.project_id}/{asset.id}/{version.id}/original{ext}"

    # Initiate S3 multipart upload
    upload_id = create_multipart_upload(s3_key, body.mime_type)

    # Record which S3 upload backs this version. Without it nothing server-side can
    # map a version to its multipart upload, so the reaper has to sweep the whole
    # bucket and presign-part has nothing to validate against.
    version.upload_id = upload_id
    version.last_activity_at = datetime.now(timezone.utc)

    # Create MediaFile record
    file_type_map = {AssetType.image: FileType.image, AssetType.audio: FileType.audio, AssetType.video: FileType.video, AssetType.image_carousel: FileType.image}
    media_file = MediaFile(
        version_id=version.id,
        file_type=file_type_map.get(asset.asset_type, FileType.video),
        original_filename=body.original_filename,
        mime_type=body.mime_type,
        file_size_bytes=body.file_size_bytes,
        s3_key_raw=s3_key,
    )
    db.add(media_file)
    db.commit()

    return InitiateUploadResponse(
        upload_id=upload_id,
        s3_key=s3_key,
        asset_id=asset.id,
        version_id=version.id,
    )


@router.post("/presign-part", response_model=PresignPartResponse)
def presign_part(
    body: PresignPartRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if body.part_number < 1 or body.part_number > 10000:
        raise HTTPException(status_code=400, detail="Part number must be between 1 and 10000")

    # Verify the s3_key belongs to an upload initiated by this user
    media_file = db.query(MediaFile).filter(MediaFile.s3_key_raw == body.s3_key).first()
    if not media_file:
        raise HTTPException(status_code=404, detail="Upload not found")
    version = db.query(AssetVersion).filter(
        AssetVersion.id == media_file.version_id,
        # A version the reaper has already soft-deleted must not keep accepting
        # parts: those bytes would be written to a key nothing owns, and no later
        # sweep would attribute them to anything.
        AssetVersion.deleted_at.is_(None),
    ).first()
    if not version or version.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized for this upload")

    # Sign only the upload this version actually belongs to. Previously whatever
    # upload id the caller sent was passed straight to the signer, because there
    # was nothing recorded to compare it against. NULL means the row predates
    # that being stored, so it is accepted rather than breaking uploads that are
    # already in flight across the upgrade.
    if version.upload_id is not None and version.upload_id != body.upload_id:
        raise HTTPException(status_code=403, detail="Not authorized for this upload")

    url = presign_upload_part(body.s3_key, body.upload_id, body.part_number)

    # Proof of life for the reaper: an upload slower than its window is still
    # making progress and must not be aborted underneath the user.
    version.last_activity_at = datetime.now(timezone.utc)
    db.commit()

    return PresignPartResponse(presigned_url=url, part_number=body.part_number)


def _storage_unreachable(what: str = "check") -> HTTPException:
    """The answer to "could not find out" on every path that has to give one.

    Never 409. A conflict says the request can never succeed, and this client
    treats it as final -- it marks the upload failed and fires /upload/abort -- so
    answering a storage hiccup that way destroys a version that may be complete.
    """
    return HTTPException(
        status_code=503,
        detail=f"Could not reach storage to {what} this upload. Please retry.",
        headers={"Retry-After": "5"},
    )


def _already_assembled(s3_key: str, expected_bytes: int, version_id) -> bool | None:
    """Whether a fully assembled object is sitting at `s3_key` at the expected size.

    Three answers, not two: True, False, and None for "storage could not tell us".
    Used to distinguish "this upload already finished" from "this upload is gone".
    Size rather than ETag, because a completed multipart object's ETag is a
    composite whose form is not guaranteed off AWS.

    The third answer is the point. Every caller here does something destructive or
    user-visible with a False -- marks a version failed and hands it to the reaper,
    or tells a client its upload is not there -- and a failed lookup is not
    evidence of absence. Collapsing the two loses finished uploads: a HeadObject
    that times out during an abort would write off a fully transferred master,
    which the reaper then deletes a day later.
    """
    try:
        return head_object_size(s3_key) == expected_bytes
    except (ClientError, BotoCoreError, ObjectSizeUnavailable):
        # All three, because they are the three ways to not get an answer: a refusal
        # from the backend is a ClientError, never reaching it --
        # EndpointConnectionError, ConnectTimeoutError, ReadTimeoutError -- is a
        # BotoCoreError, and a 200 carrying no size at all is neither.
        logger.warning("could not check whether upload %s already completed", version_id,
                       exc_info=True)
        return None


def _parts_from_listing(stored: list[dict], expected_total_bytes: int) -> list[dict]:
    """Turn what the backend holds into a parts list for CompleteMultipartUpload.

    ListParts proves a part exists; it does not prove the set is complete. That
    distinction is the whole point of this function, because completing with a
    gap is not an error on most backends: MinIO, Garage and SeaweedFS all
    assemble the parts they were given and return success, so a client that
    under-reports produces a silently truncated master that transcodes fine and
    shows a green tick. Only Ceph rejects it.

    Validated here, against the size the client declared at initiate:
      - part numbers are exactly 1..N with no holes
      - every part but the last is the same size (also what R2 requires)
      - the sizes add up to the whole file

    Raises ValueError with a message meant for the uploader.
    """
    by_number: dict[int, list[dict]] = {}
    for part in stored:
        by_number.setdefault(part["PartNumber"], []).append(part)

    numbers = sorted(by_number)
    if not numbers:
        raise ValueError("No uploaded parts were found for this upload.")
    if numbers != list(range(1, len(numbers) + 1)):
        missing = sorted(set(range(1, numbers[-1] + 1)) - set(numbers))
        raise ValueError(
            f"Upload is incomplete: {len(missing)} part(s) missing, starting at part {missing[0]}."
        )

    # A part number listed twice means the backend kept both writes of a retried
    # part (SeaweedFS does this). Picking between them needs the ETag to match the
    # bytes we want, which is exactly the thing we cannot verify, so refuse rather
    # than guess: choosing the stale row would assemble the wrong bytes silently.
    duplicated = [n for n in numbers if len(by_number[n]) > 1]
    if duplicated:
        raise ValueError(
            f"Storage reported part {duplicated[0]} more than once; please upload this file again."
        )

    parts = [by_number[n][0] for n in numbers]
    if any(p["Size"] is None for p in parts):
        raise ValueError("Storage did not report part sizes, so the upload cannot be verified.")

    chunk_size = parts[0]["Size"]
    for part in parts[:-1]:
        if part["Size"] != chunk_size:
            raise ValueError(
                f"Part {part['PartNumber']} is {part['Size']} bytes but every part before the "
                f"last must be {chunk_size}; please upload this file again."
            )
    if parts[-1]["Size"] > chunk_size:
        raise ValueError("The final part is larger than the parts before it.")

    total = sum(p["Size"] for p in parts)
    if total != expected_total_bytes:
        raise ValueError(
            f"Uploaded {total} bytes but the file was declared as {expected_total_bytes}."
        )

    return [{"PartNumber": p["PartNumber"], "ETag": p["ETag"]} for p in parts]


@router.post("/complete", response_model=CompleteUploadResponse)
def complete_upload(
    body: CompleteUploadRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Validate DB first
    version = db.query(AssetVersion).filter(
        AssetVersion.id == body.version_id,
        AssetVersion.deleted_at.is_(None),
    ).first()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    if version.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized for this upload")

    # Same reasoning as the key below, for the id nothing downstream questions:
    # `_trigger_processing` hands this straight to `process_asset`, which resolves
    # the asset with no cross-check of its own and derives both the output prefix
    # and the SSE channel from whatever it finds. Ownership was proved for the
    # version, never for the asset id the body carried, so a mismatch here is one
    # version's owner writing their transcode into somebody else's project.
    if body.asset_id != version.asset_id:
        raise HTTPException(status_code=400, detail="Asset does not match this version")

    # Match the key against this version rather than taking the request's word for
    # it: ownership was proved for the version, never for whatever key the body
    # carried. Matching on both also keeps working if a version ever holds more
    # than one file, which an image carousel would need.
    media_file = db.query(MediaFile).filter(
        MediaFile.version_id == version.id,
        MediaFile.s3_key_raw == body.s3_key,
    ).first()
    if not media_file:
        raise HTTPException(status_code=404, detail="Upload not found for this version")

    s3_key = media_file.s3_key_raw

    # Only an upload that is still uploading can be *completed*. Without this, a
    # replay of this request against an already-finished version rewinds it to
    # `processing` and queues a second transcode -- and because `/upload/*` is
    # exempt from the global rate limiter, a loop over it would park the whole
    # transcoding queue on re-runs. The upload id is not a credential either: any
    # unrecognised value reads as "already gone", so replaying needs no secret.
    #
    # A retry after a lost response lands here too, though, and it is the more
    # common way to arrive: the first call committed `processing` and then the
    # response never made it back. Answering that with 409 tells a user whose
    # upload worked that it failed -- and the client fires /upload/abort from the
    # catch of every completion failure, so the report is not even inert. Ask
    # storage first: if the assembled object is sitting there at the declared
    # size, this request already succeeded, and saying so costs one HeadObject on
    # a path that is by definition not the hot one.
    #
    # The replay protection is unchanged. Everything expensive -- the status
    # write, and the transcode dispatch -- still only ever runs from `uploading`.
    if version.processing_status != ProcessingStatus.uploading:
        # Only these two mean a completion actually ran. `failed` is a version
        # somebody resolved as broken; answering that with a success because an
        # object happens to sit at the key would paper over the disagreement
        # rather than surface it.
        completed_before = version.processing_status in (
            ProcessingStatus.processing,
            ProcessingStatus.ready,
        )
        # Refuse a mismatched upload id from stored state, without a network call --
        # the same check presign-part already makes. This is a filter, not a
        # discriminator: a replay of a captured request carries the *correct* id, so
        # it only rejects the ones that made an id up. It still means the storage
        # lookup below is reachable in a loop on an endpoint family the global rate
        # limiter exempts, bounded only by the probe client's timeouts.
        # NULL means the row predates upload ids being stored.
        same_upload = version.upload_id is None or version.upload_id == body.upload_id
        assembled = (
            _already_assembled(s3_key, media_file.file_size_bytes, version.id)
            if completed_before and same_upload
            else False
        )
        if assembled:
            # Re-read before answering, and re-apply the carve-out to what comes
            # back. The status was loaded before a network call that can take
            # seconds and the transcode runs in another process, so it can have
            # moved either way since -- and a version that went `failed` during the
            # HeadObject must get the same 409 it would have got a moment earlier,
            # not a 200 with "failed" in the body.
            db.refresh(version)
            if version.processing_status in (
                ProcessingStatus.processing,
                ProcessingStatus.ready,
            ):
                logger.info(
                    "completion retried for upload %s after it already finished; "
                    "reporting %s", version.id, version.processing_status.value,
                )
                # The version's own status, not a hardcoded "processing": one that
                # has since gone `ready` must not read as still transcoding.
                return CompleteUploadResponse(
                    status=version.processing_status.value,
                    asset_id=version.asset_id,
                    version_id=version.id,
                )
        elif assembled is None:
            raise _storage_unreachable()
        raise HTTPException(
            status_code=409,
            detail=f"This upload is already {version.processing_status.value}.",
        )

    def _reconcile_size() -> None:
        """Record what storage actually holds, not what the client declared.

        file_size_bytes is written once at initiate from a number the client
        chose, and until now it was never compared with reality. Both the
        per-file limit and the instance storage cap are enforced against that
        column, and per-project usage is a SUM over it, so a client that
        under-declares makes every one of those answers wrong -- and stays wrong,
        because nothing ever revisits the row.

        A HeadObject after assembly is the portable way to find out: the object
        is there, and ContentLength is the one integrity signal that holds across
        S3-compatible backends (a composite ETag's form is not guaranteed off
        AWS). It does not make the pre-upload guard binding -- the bytes have
        already landed by the time we can ask -- but it stops one wrong number
        from permanently defeating the accounting. Best-effort: the upload
        genuinely succeeded, so a storage hiccup here must not fail it.
        """
        try:
            actual = head_object_size(s3_key)
        except Exception:  # noqa: BLE001 - reconciliation must never fail a good upload
            logger.warning("could not reconcile size for version %s", version.id, exc_info=True)
            return
        if actual is None or actual == media_file.file_size_bytes:
            return
        logger.warning(
            "version %s declared %d bytes but storage holds %d; recording the actual size",
            version.id, media_file.file_size_bytes, actual,
        )
        media_file.file_size_bytes = actual

    def _finish() -> CompleteUploadResponse:
        # Read the ids before the commit: `expire_on_commit` is on, so touching
        # them afterwards costs a fresh SELECT per completion.
        asset_id, version_id = version.asset_id, version.id
        _reconcile_size()

        # Claim the version rather than assigning to it. The status check above is
        # an unsynchronised read, so two concurrent completions can both pass it:
        # the loser's CompleteMultipartUpload fails NoSuchUpload (completing
        # consumed the id), it finds the object assembled, and it arrives here too.
        # Assigning would let both dispatch, and two transcodes would write the
        # same processed/ prefix at once.
        #
        # UPDATE ... WHERE processing_status = 'uploading' makes exactly one of
        # them win, decided by the row lock rather than by timing. Both callers
        # still get the same successful answer, because for the loser the work
        # genuinely is underway -- it just is not this request that started it.
        claimed = (
            db.query(AssetVersion)
            .filter(
                AssetVersion.id == version_id,
                AssetVersion.processing_status == ProcessingStatus.uploading,
            )
            .update(
                {AssetVersion.processing_status: ProcessingStatus.processing},
                synchronize_session=False,
            )
        )
        db.commit()

        if claimed:
            # The bulk UPDATE does not touch the instance already loaded in this
            # session, so without this the row says `processing` while the object
            # in hand still says `uploading`.
            version.processing_status = ProcessingStatus.processing
            # The rows, not the request. The guard above makes these equal, but
            # reading them from the version keeps the dispatch correct on its own
            # rather than by way of a check thirty lines up that a later edit
            # could move.
            background_tasks.add_task(_trigger_processing, asset_id, version_id)
        else:
            # Someone else moved it off `uploading` first. Dispatching again would
            # be the double transcode this guard exists to prevent. A version that
            # ends up claimed but never dispatched is recoverable separately (#270)
            # and must not be papered over by re-dispatching on every retry.
            logger.info(
                "completion for version %s did not claim it; another request is "
                "already processing it",
                version_id,
            )

        return CompleteUploadResponse(
            status="processing", asset_id=asset_id, version_id=version_id
        )

    try:
        stored = list_upload_parts(s3_key, body.upload_id)
    except (ClientError, BotoCoreError) as e:
        # This runs on every genuine completion, not just on a retry, and it had no
        # handling at all: list_upload_parts re-raises everything outside
        # UPLOAD_GONE_CODES, so a SlowDown or a connection blip at the end of a
        # multi-hour transfer escaped as a 500. The client answers any completion
        # failure with /upload/abort, which correctly reports not-assembled --
        # CompleteMultipartUpload never ran -- and commits `failed`, and the reaper
        # then deletes a file that transferred perfectly.
        logger.warning("listing parts for upload %s failed: %s", version.id, e)
        raise HTTPException(
            status_code=503,
            detail="Could not reach storage to complete this upload. Please retry.",
            headers={"Retry-After": "5"},
        ) from e
    except MultipartUploadGone:
        # Completing consumes the upload id, so a client that retries after losing
        # the first response lands here. If the object is sitting there at the right
        # size the work is already done, and saying so is far better than failing:
        # a version left at `uploading` is deleted by the reaper a day later.
        assembled = _already_assembled(s3_key, media_file.file_size_bytes, version.id)
        if assembled:
            logger.warning("upload %s was already complete; treating retry as success", version.id)
            return _finish()
        if assembled is None:
            # "Could not find out" is not "gone". Telling the client to upload the
            # whole file again over a storage hiccup is the worst answer available
            # here, and it is the one this branch used to give.
            raise _storage_unreachable()
        raise HTTPException(
            status_code=409,
            detail="This upload is no longer available. Please upload the file again.",
        )
    except MultipartListingUnsupported:
        logger.warning(
            "storage backend does not support ListParts; completing upload %s from the "
            "client-reported part list, which cannot be verified",
            version.id,
        )
        stored = None

    if stored is None:
        if not body.parts:
            raise HTTPException(status_code=400, detail="No parts were reported for this upload.")
        parts = [p.model_dump() for p in body.parts]
    else:
        try:
            parts = _parts_from_listing(stored, media_file.file_size_bytes)
        except ValueError as e:
            # The user has just spent minutes or hours transferring this. Whatever we
            # tell them, the operator needs enough to correlate a support ticket:
            # rejecting after every byte moved is precisely the shape of failure that
            # made this class of bug so hard to find in the first place.
            logger.warning(
                "rejected completion of upload %s (user %s, key %s): %s "
                "[%d parts listed, %d bytes declared]",
                version.id, current_user.id, s3_key, e, len(stored),
                media_file.file_size_bytes,
            )
            raise HTTPException(status_code=409, detail=str(e)) from e

    try:
        complete_multipart_upload(s3_key, body.upload_id, parts)
    except ClientError as e:
        # Same race as above, one step later: another request completed this upload
        # between our listing and our call.
        if str(e.response.get("Error", {}).get("Code", "")) in UPLOAD_GONE_CODES:
            assembled = _already_assembled(s3_key, media_file.file_size_bytes, version.id)
            if assembled:
                return _finish()
            if assembled is None:
                raise _storage_unreachable() from e
        logger.warning("completing upload %s failed: %s", version.id, e)
        raise
    except BotoCoreError as e:
        # Never reaching the backend is not a ClientError, and this is the longest
        # call in the handler: CompleteMultipartUpload on a multi-gigabyte object can
        # sit for minutes while it assembles. A read timeout here says nothing about
        # whether it worked, so ask the same question the gone-code branch asks
        # rather than letting it escape as a 500 the client answers with an abort.
        if _already_assembled(s3_key, media_file.file_size_bytes, version.id) is True:
            logger.warning(
                "completing upload %s did not answer (%s) but the object is assembled; "
                "treating it as done", version.id, e,
            )
            return _finish()
        logger.warning("completing upload %s failed: %s", version.id, e)
        raise HTTPException(
            status_code=503,
            detail="Could not reach storage to complete this upload. Please retry.",
            headers={"Retry-After": "5"},
        ) from e

    return _finish()


def _trigger_processing(asset_id: uuid.UUID, version_id: uuid.UUID):
    """Dispatch Celery task to process the uploaded asset."""
    from ..tasks.transcode_tasks import process_asset
    from ..tasks.celery_app import send_task_safe
    send_task_safe(process_asset, str(asset_id), str(version_id))


@router.post("/abort", status_code=status.HTTP_204_NO_CONTENT)
def abort_upload(
    body: AbortUploadRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    version = db.query(AssetVersion).filter(
        AssetVersion.id == body.version_id,
        AssetVersion.deleted_at.is_(None),
    ).first()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    if version.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized for this upload")

    # The status write must happen even if S3 refuses the abort. An upload the
    # reaper already took raises NoSuchUpload here, and letting that propagate
    # leaves the version at `uploading` forever -- indistinguishable in the UI
    # from a stalled transcode, and the exact state this endpoint exists to avoid.
    try:
        abort_multipart_upload(body.s3_key, body.upload_id)
    except ClientError as e:
        # Only swallow "there was nothing to abort". Anything else -- a permissions
        # problem, the wrong bucket, a throttle -- means parts are still sitting in
        # storage, and reporting success would hide that from the operator.
        if str(e.response.get("Error", {}).get("Code", "")) not in UPLOAD_GONE_CODES:
            logger.warning("abort of upload %s failed: %s", version.id, e)
            raise
        logger.info("upload %s was already gone when aborted", version.id)
    except BotoCoreError as e:
        # Never reaching the backend is a sibling class of being refused by it, so
        # it gets the same treatment a non-gone ClientError already gets above: the
        # request stops here and the status is left alone, because parts are still
        # sitting in storage and reporting success would hide that. The only change
        # from the unhandled 500 this used to be is a code that says "try again".
        # It does leave the version in the panel's Active tab; the fix for that is
        # a client that retries, not a status written on a guess.
        logger.warning("abort of upload %s could not reach storage: %s", version.id, e)
        raise HTTPException(
            status_code=503,
            detail="Could not reach storage to abort this upload. Please retry.",
            headers={"Retry-After": "5"},
        ) from e

    # Only an upload still in progress is resolved here. The client fires this from
    # the catch of every completion failure, so a version that already reached
    # `processing` must be left alone.
    if version.processing_status == ProcessingStatus.uploading:
        # Still `uploading` does not prove the upload failed. CompleteMultipartUpload
        # can have succeeded with the process dying before the status was committed,
        # which leaves a finished object and a version that still looks in-flight.
        # Marking that failed hands it to the reaper, which deletes the finished file
        # a day later -- so ask storage what actually happened before deciding.
        media_file = db.query(MediaFile).filter(
            MediaFile.version_id == version.id,
            MediaFile.s3_key_raw == body.s3_key,
        ).first()
        assembled = (
            _already_assembled(body.s3_key, media_file.file_size_bytes, version.id)
            if media_file is not None
            else False
        )
        # Only a confirmed object promotes the version. "Could not find out" is
        # recorded as failed exactly like "not there", because the two have the
        # same consequence: `_reap_stale_uploads` sweeps `uploading` and `failed`
        # on identical criteria, so leaving it `uploading` saves no bytes and only
        # parks the row in the panel's Active tab instead of Failed.
        if assembled:
            logger.warning(
                "abort called for upload %s but the object is already complete; "
                "recording it as processing instead of failed", version.id,
            )
            version.processing_status = ProcessingStatus.processing
            db.commit()
            background_tasks.add_task(_trigger_processing, version.asset_id, version.id)
            return
        version.processing_status = ProcessingStatus.failed
        db.commit()
