from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, literal, select
import os
import uuid
from datetime import datetime, timezone
from typing import Optional
from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.asset import Asset, AssetVersion, MediaFile, AssetType, FileType, ProcessingStatus
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.share import AssetShare
from ..models.activity import Mention, Notification, NotificationType
from ..models.comment import Comment, COMMENT_TREE_MAX_DEPTH
from ..schemas.asset import AssetResponse, AssetVersionResponse, AssetUpdate, StreamUrlResponse, MediaFileResponse, DownloadOption
from ..schemas.notification import AssignmentUpdate
from ..services.permissions import require_project_role, require_project_visible, require_asset_access
from ..services.s3_service import generate_presigned_get_url, build_download_filename
from ..services.downloads import (
    describe_choices, download_choices, download_filename, may_download_original,
    original_allowed_for_download, pick_or_refuse,
)
from .hls_proxy import create_hls_token
from ..schemas.upload import (
    InitiateUploadRequest, InitiateUploadResponse,
    ALLOWED_MIME_TYPES, mime_to_asset_type,
)
from ..services.storage import choose_part_size, upload_guard_error
from ..services.versions import next_version_number
from ..services.s3_service import create_multipart_upload
from .upload import storage_initiate_error

router = APIRouter(tags=["assets"])


# A version in one of these is not something a viewer can open: it is an upload in
# flight or one that died. It is still the newest version by number, which is why
# "latest" and "the one to show" are not the same question.
_UNVIEWABLE_STATUSES = (ProcessingStatus.uploading, ProcessingStatus.failed)


def _pick_version(db: Session, asset_id: uuid.UUID, preferred) -> AssetVersion | None:
    """Newest version matching `preferred`, falling back to the newest overall.

    The fallback is what keeps a brand new asset honest: with nothing preferable to
    show it still reports the version that is uploading, rather than reporting
    nothing at all.
    """
    base = (AssetVersion.asset_id == asset_id, AssetVersion.deleted_at.is_(None))
    hit = db.query(AssetVersion).filter(*base, preferred).order_by(
        AssetVersion.version_number.desc()
    ).first()
    if hit:
        return hit
    return db.query(AssetVersion).filter(*base).order_by(
        AssetVersion.version_number.desc()
    ).first()


def _display_version(db: Session, asset_id: uuid.UUID) -> AssetVersion | None:
    """The version to show for an asset in a listing or detail view.

    An interrupted v2 no longer makes an approved, viewable v1 read as failed for
    the whole reaper window. `processing` counts as showable, because "this one is
    being worked on" is true and useful.
    """
    return _pick_version(
        db, asset_id, AssetVersion.processing_status.notin_(_UNVIEWABLE_STATUSES)
    )


def _playable_version(db: Session, asset_id: uuid.UUID) -> AssetVersion | None:
    """The version to serve when a caller asked for the asset without naming one.

    Stricter than `_display_version`: only `ready` can actually be streamed or
    downloaded, so a v2 that is merely processing must not shadow a v1 that plays.
    """
    return _pick_version(
        db, asset_id, AssetVersion.processing_status == ProcessingStatus.ready
    )


def _comment_counts(db: Session, version_ids: list) -> dict:
    """Comments on each version, as its comment panel shows them, by version id.

    The panel lists a version's live top-level comments, public and internal,
    each with its live replies down to COMMENT_TREE_MAX_DEPTH; a reply under a
    deleted comment is not shown and is not counted. One query for all the
    versions, so a grid of assets costs one round trip, not one per card. The
    share grid counts the same way with internal comments left out
    (_latest_version_comment_count in routers/share.py).
    """
    if not version_ids:
        return {}
    tree = select(
        Comment.id.label("id"),
        Comment.version_id.label("version_id"),
        literal(0).label("depth"),
    ).where(
        Comment.version_id.in_(version_ids),
        Comment.parent_id.is_(None),
        Comment.deleted_at.is_(None),
    ).cte(name="panel_comments", recursive=True)
    replies = select(
        Comment.id,
        tree.c.version_id,
        (tree.c.depth + 1),
    ).join(tree, Comment.parent_id == tree.c.id).where(
        Comment.deleted_at.is_(None),
        tree.c.depth < COMMENT_TREE_MAX_DEPTH,
    )
    tree = tree.union_all(replies)
    rows = db.query(tree.c.version_id, func.count(tree.c.id)).group_by(tree.c.version_id).all()
    return {version_id: count for version_id, count in rows}


def _build_asset_response(asset: Asset, db: Session) -> AssetResponse:
    """Build AssetResponse with latest version and its files."""
    latest_version = _display_version(db, asset.id)

    version_response = None
    thumbnail_url = None
    if latest_version:
        files = db.query(MediaFile).filter(MediaFile.version_id == latest_version.id).all()
        version_response = AssetVersionResponse.model_validate(latest_version)
        version_response.files = [MediaFileResponse.model_validate(f) for f in files]
        # Get thumbnail from first file that has one.
        # Audio stores waveform JSON in s3_key_thumbnail — skip it, it's not an image.
        if asset.asset_type != AssetType.audio:
            for f in files:
                if f.s3_key_thumbnail:
                    thumbnail_url = generate_presigned_get_url(f.s3_key_thumbnail)
                    break

    resp = AssetResponse.model_validate(asset)
    resp.latest_version = version_response
    resp.thumbnail_url = thumbnail_url
    if latest_version:
        resp.comment_count = _comment_counts(db, [latest_version.id]).get(latest_version.id, 0)
    return resp


def _build_asset_responses_bulk(assets: list[Asset], db: Session) -> list[AssetResponse]:
    """Build AssetResponse list with bulk-loaded versions and files (no N+1)."""
    if not assets:
        return []

    asset_ids = [a.id for a in assets]

    # Bulk load the version to display per asset, matching _display_version: the
    # newest viewable one, falling back to the newest overall. Two grouped queries
    # rather than one, still no N+1.
    def _max_version_rows(viewable_only: bool):
        q = db.query(
            AssetVersion.asset_id,
            func.max(AssetVersion.version_number).label("max_version"),
        ).filter(AssetVersion.asset_id.in_(asset_ids), AssetVersion.deleted_at.is_(None))
        if viewable_only:
            q = q.filter(AssetVersion.processing_status.notin_(_UNVIEWABLE_STATUSES))
        subq = q.group_by(AssetVersion.asset_id).subquery()
        return (
            db.query(AssetVersion)
            .join(
                subq,
                (AssetVersion.asset_id == subq.c.asset_id)
                & (AssetVersion.version_number == subq.c.max_version),
            )
            .all()
        )

    version_by_asset = {v.asset_id: v for v in _max_version_rows(viewable_only=False)}
    # Viewable wins where one exists; the fallback above covers assets with none.
    version_by_asset.update({v.asset_id: v for v in _max_version_rows(viewable_only=True)})
    latest_versions = list(version_by_asset.values())

    # Bulk load media files for all those versions
    version_ids = [v.id for v in latest_versions]
    all_files = db.query(MediaFile).filter(MediaFile.version_id.in_(version_ids)).all() if version_ids else []
    comment_counts = _comment_counts(db, version_ids)
    files_by_version: dict = {}
    for f in all_files:
        files_by_version.setdefault(f.version_id, []).append(f)

    result = []
    for asset in assets:
        version = version_by_asset.get(asset.id)
        version_response = None
        thumbnail_url = None
        if version:
            files = files_by_version.get(version.id, [])
            version_response = AssetVersionResponse.model_validate(version)
            version_response.files = [MediaFileResponse.model_validate(f) for f in files]
            # Audio stores waveform JSON in s3_key_thumbnail — skip it, it's not an image.
            if asset.asset_type != AssetType.audio:
                for f in files:
                    if f.s3_key_thumbnail:
                        thumbnail_url = generate_presigned_get_url(f.s3_key_thumbnail)
                        break

        asset_resp = AssetResponse.model_validate(asset)
        asset_resp.latest_version = version_response
        asset_resp.thumbnail_url = thumbnail_url
        asset_resp.comment_count = comment_counts.get(version.id, 0) if version else 0
        result.append(asset_resp)
    return result


@router.get("/projects/{project_id}/assets", response_model=list[AssetResponse])
def list_assets(
    project_id: uuid.UUID,
    include_failed: bool = Query(False, description="Include assets whose latest version failed processing"),
    folder_id: Optional[str] = Query(None, description="Filter by folder. 'root' for root level, UUID for specific folder."),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Allow access if user is a project member OR the project is public
    require_project_visible(db, project_id, current_user)

    query = db.query(Asset).filter(
        Asset.project_id == project_id,
        Asset.deleted_at.is_(None),
    )

    if folder_id == "root":
        query = query.filter(Asset.folder_id.is_(None))
    elif folder_id is not None:
        query = query.filter(Asset.folder_id == uuid.UUID(folder_id))

    assets = query.all()

    if not include_failed:
        # Exclude assets where the only version is failed or still uploading
        asset_ids = [a.id for a in assets]
        if asset_ids:
            # Find assets that have at least one non-failed, non-uploading version
            usable = set(
                row[0] for row in db.query(AssetVersion.asset_id).filter(
                    AssetVersion.asset_id.in_(asset_ids),
                    AssetVersion.deleted_at.is_(None),
                    AssetVersion.processing_status.notin_([ProcessingStatus.failed, ProcessingStatus.uploading]),
                ).distinct().all()
            )
            # Also include assets with no versions yet (just created)
            has_any_version = set(
                row[0] for row in db.query(AssetVersion.asset_id).filter(
                    AssetVersion.asset_id.in_(asset_ids),
                    AssetVersion.deleted_at.is_(None),
                ).distinct().all()
            )
            assets = [a for a in assets if a.id in usable or a.id not in has_any_version]

    return _build_asset_responses_bulk(assets, db)


@router.get("/assets/{asset_id}", response_model=AssetResponse)
def get_asset(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)
    return _build_asset_response(asset, db)


@router.patch("/assets/{asset_id}", response_model=AssetResponse)
def update_asset(
    asset_id: uuid.UUID,
    body: AssetUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(asset, field, value)
    db.commit()
    db.refresh(asset)
    return _build_asset_response(asset, db)


@router.delete("/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_asset(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)
    asset.deleted_at = datetime.now(timezone.utc)
    db.commit()


@router.get("/assets/{asset_id}/versions", response_model=list[AssetVersionResponse])
def list_asset_versions(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)

    versions = db.query(AssetVersion).filter(
        AssetVersion.asset_id == asset_id,
        AssetVersion.deleted_at.is_(None),
    ).order_by(AssetVersion.version_number.desc()).all()

    result = []
    version_ids = [v.id for v in versions]
    all_files = db.query(MediaFile).filter(MediaFile.version_id.in_(version_ids)).all() if version_ids else []
    files_by_version: dict = {}
    for f in all_files:
        files_by_version.setdefault(f.version_id, []).append(f)

    for v in versions:
        vr = AssetVersionResponse.model_validate(v)
        vr.files = [MediaFileResponse.model_validate(f) for f in files_by_version.get(v.id, [])]
        result.append(vr)
    return result


def _ready_media_file(
    db: Session, asset_id: uuid.UUID, version_id: Optional[uuid.UUID], current_user: User,
) -> tuple[Asset, MediaFile]:
    """The asset and the media file of the version a stream or download serves."""
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)

    # Get the requested version or latest
    if version_id:
        version = db.query(AssetVersion).filter(
            AssetVersion.id == version_id,
            AssetVersion.asset_id == asset_id,
            AssetVersion.deleted_at.is_(None),
        ).first()
    else:
        # With no version asked for, serve the newest one that can actually play.
        # Picking the highest-numbered version regardless meant an upload in flight,
        # or one that died, made every earlier version unplayable: the newest was
        # selected and then rejected as not ready, with no way to reach v1 short of
        # naming its id. The share-side viewer already resolves it this way.
        version = _playable_version(db, asset_id)

    if not version:
        raise HTTPException(status_code=404, detail="No version found")
    if version.processing_status != ProcessingStatus.ready:
        raise HTTPException(status_code=409, detail="Asset version is not ready yet")

    media_file = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
    if not media_file:
        raise HTTPException(status_code=404, detail="Media file not found")
    return asset, media_file


@router.get("/assets/{asset_id}/stream", response_model=StreamUrlResponse)
def get_stream_url(
    asset_id: uuid.UUID,
    version_id: Optional[uuid.UUID] = Query(default=None),
    download: bool = Query(default=False),
    # Which file a download serves: an id from GET /assets/{id}/downloads.
    # Omitted, a download is the first transcode, as it was before the choice.
    rendition: Optional[str] = Query(default=None, max_length=32),
    # Bulk downloads: the original when the instance allows originals outside a
    # project, else the default. Members included; see original_allowed_for_download.
    prefer_original: bool = Query(default=False),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset, media_file = _ready_media_file(db, asset_id, version_id, current_user)

    if download:
        # A download needs one file, and the ladder is segments. With no choice
        # made this is the MP4 remuxed from the top rung: it is what the reviewer
        # watched, where the raw file is the camera master and can be an order of
        # magnitude larger. Versions transcoded before that rung existed (and any
        # whose remux failed) have none, and still get the master.
        choice = pick_or_refuse(
            asset, media_file, rendition,
            allow_original=original_allowed_for_download(
                db, asset, current_user, rendition, prefer_original,
            ),
            prefer_original=prefer_original,
        )
        url = generate_presigned_get_url(
            choice.s3_key, download_filename=download_filename(asset, media_file, choice),
        )
    elif asset.asset_type == AssetType.video and media_file.s3_key_processed:
        # Route through the HLS proxy so the master playlist, variant
        # playlists, and .ts segments all get served via short-lived
        # presigned URLs — the S3 bucket can stay fully private. (#51)
        token = create_hls_token(media_file.s3_key_processed)
        url = f"/stream/hls/master.m3u8?token={token}"
    else:
        url = generate_presigned_get_url(media_file.s3_key_processed or media_file.s3_key_raw)

    return StreamUrlResponse(url=url, asset_type=asset.asset_type)


@router.get("/assets/{asset_id}/downloads", response_model=list[DownloadOption])
def list_download_options(
    asset_id: uuid.UUID,
    version_id: Optional[uuid.UUID] = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """The files a version can be downloaded as: the original, then each transcode."""
    asset, media_file = _ready_media_file(db, asset_id, version_id, current_user)
    choices = download_choices(
        asset.asset_type, media_file,
        allow_original=may_download_original(db, asset, current_user),
    )
    describe_choices(asset.asset_type, media_file, choices)
    return [
        DownloadOption(id=c.id, label=c.label, format=c.format, size_bytes=c.size_bytes)
        for c in choices
    ]


@router.post("/assets/{asset_id}/versions", response_model=InitiateUploadResponse)
def initiate_new_version(
    asset_id: uuid.UUID,
    body: InitiateUploadRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Initiate upload of a new version for an existing asset."""
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    if body.mime_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=400, detail="Unsupported file type")
    guard_error = upload_guard_error(db, body.file_size_bytes)
    if guard_error:
        raise HTTPException(status_code=400, detail=guard_error)
    part_size, part_error = choose_part_size(db, body.file_size_bytes)
    if part_error:
        raise HTTPException(status_code=400, detail=part_error)

    next_version = next_version_number(db, asset_id)

    version = AssetVersion(
        asset_id=asset_id,
        version_number=next_version,
        processing_status=ProcessingStatus.uploading,
        created_by=current_user.id,
    )
    db.add(version)
    db.flush()

    ext = os.path.splitext(body.original_filename)[1].lower()
    s3_key = f"raw/{asset.project_id}/{asset_id}/{version.id}/original{ext}"
    try:
        upload_id = create_multipart_upload(s3_key, body.mime_type)
    except Exception as exc:  # noqa: BLE001 - classified by storage_initiate_error
        err = storage_initiate_error(exc)
        if err is None:
            raise
        db.rollback()
        raise err from exc

    # Record which S3 upload backs this version. Without it nothing server-side can
    # map a version to its multipart upload, so the reaper has to sweep the whole
    # bucket and presign-part has nothing to validate against.
    version.upload_id = upload_id
    version.last_activity_at = datetime.now(timezone.utc)
    # See initiate_upload: the part size belongs to the upload, not to the build
    # of the client that happens to be pushing it.
    version.chunk_size_bytes = part_size

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
        asset_id=asset_id,
        version_id=version.id,
        chunk_size_bytes=part_size,
    )


@router.patch("/assets/{asset_id}/assignment", response_model=AssetResponse)
def update_assignment(
    asset_id: uuid.UUID,
    body: AssignmentUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    if "assignee_id" in body.model_fields_set:
        asset.assignee_id = body.assignee_id
    if "due_date" in body.model_fields_set:
        asset.due_date = body.due_date

    if "assignee_id" in body.model_fields_set and body.assignee_id is not None:
        notification = Notification(
            user_id=body.assignee_id,
            type=NotificationType.assignment,
            asset_id=asset.id,
        )
        db.add(notification)

    db.commit()
    db.refresh(asset)
    return _build_asset_response(asset, db)


@router.get("/assets/{asset_id}/assignment")
def get_assignment(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_project_role(db, asset.project_id, current_user, ProjectRole.viewer)
    return {
        "assignee_id": str(asset.assignee_id) if asset.assignee_id else None,
        "due_date": asset.due_date.isoformat() if asset.due_date else None,
    }
