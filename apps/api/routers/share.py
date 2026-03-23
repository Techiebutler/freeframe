import secrets
import uuid
from datetime import datetime, timezone
from typing import Optional
import bcrypt

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func as sa_func, case
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.asset import Asset
from ..models.folder import Folder
from ..models.share import AssetShare, ShareLink, SharePermission, ShareLinkActivity, ShareActivityAction
from ..models.activity import ActivityLog, ActivityAction
from ..models.asset import AssetVersion, AssetType, MediaFile, ProcessingStatus
from ..schemas.share import (
    DirectShareCreate,
    DirectShareResponse,
    FolderShareAssetItem,
    FolderShareAssetsResponse,
    FolderShareSubfolder,
    ShareLinkActivityResponse,
    ShareLinkCreate,
    ShareLinkListItem,
    ShareLinkResponse,
    ShareLinkUpdate,
    ShareLinkValidateResponse,
)
from ..services.permissions import require_project_role, validate_share_link
from ..services.s3_service import generate_presigned_get_url
from ..models.project import ProjectRole
from ..tasks.email_tasks import send_share_email
from ..config import settings

router = APIRouter(tags=["sharing"])


def _escape_like(s: str) -> str:
    """Escape special LIKE pattern characters to prevent injection."""
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _get_asset(db: Session, asset_id: uuid.UUID) -> Asset:
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


def _get_folder(db: Session, folder_id: uuid.UUID) -> Folder:
    folder = db.query(Folder).filter(Folder.id == folder_id, Folder.deleted_at.is_(None)).first()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    return folder


def _get_project_id_from_link(db: Session, link: ShareLink) -> uuid.UUID:
    if link.asset_id:
        asset = _get_asset(db, link.asset_id)
        return asset.project_id
    elif link.folder_id:
        folder = db.query(Folder).filter(Folder.id == link.folder_id, Folder.deleted_at.is_(None)).first()
        if not folder:
            raise HTTPException(status_code=404, detail="Shared folder not found")
        return folder.project_id
    raise HTTPException(status_code=400, detail="Invalid share link")


def _log_share_activity(
    db: Session,
    share_link_id: uuid.UUID,
    action: ShareActivityAction,
    actor_email: str,
    actor_name: Optional[str] = None,
    asset_id: Optional[uuid.UUID] = None,
    asset_name: Optional[str] = None,
):
    try:
        activity = ShareLinkActivity(
            share_link_id=share_link_id,
            action=action,
            actor_email=actor_email,
            actor_name=actor_name,
            asset_id=asset_id,
            asset_name=asset_name,
        )
        db.add(activity)
        db.commit()
    except Exception:
        db.rollback()


def _is_descendant_of(db: Session, folder_id: uuid.UUID, ancestor_id: uuid.UUID) -> bool:
    """Check if folder_id is a descendant of ancestor_id via parent chain traversal."""
    current_id = folder_id
    visited = set()
    while current_id and current_id not in visited:
        if current_id == ancestor_id:
            return True
        visited.add(current_id)
        folder = db.query(Folder.parent_id).filter(Folder.id == current_id).first()
        current_id = folder.parent_id if folder else None
    return False


def _get_latest_media_file(db: Session, asset_id: uuid.UUID) -> Optional[MediaFile]:
    """Get the first media file from the latest ready version of an asset."""
    version = db.query(AssetVersion).filter(
        AssetVersion.asset_id == asset_id,
        AssetVersion.deleted_at.is_(None),
        AssetVersion.processing_status == ProcessingStatus.ready,
    ).order_by(AssetVersion.version_number.desc()).first()
    if not version:
        return None
    return db.query(MediaFile).filter(MediaFile.version_id == version.id).first()


# ── Share links ───────────────────────────────────────────────────────────────

@router.post("/assets/{asset_id}/share", response_model=ShareLinkResponse, status_code=status.HTTP_201_CREATED)
def create_share_link(
    asset_id: uuid.UUID,
    body: ShareLinkCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = _get_asset(db, asset_id)
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    token = secrets.token_urlsafe(32)
    if body.password:
        pwd_bytes = body.password[:72].encode('utf-8')
        salt = bcrypt.gensalt()
        password_hash = bcrypt.hashpw(pwd_bytes, salt).decode('utf-8')
    else:
        password_hash = None

    link = ShareLink(
        asset_id=asset_id,
        token=token,
        created_by=current_user.id,
        title=body.title if body.title else asset.name,
        description=body.description,
        expires_at=body.expires_at,
        password_hash=password_hash,
        permission=body.permission,
        allow_download=body.allow_download,
        show_versions=body.show_versions,
        show_watermark=body.show_watermark,
        appearance=body.appearance.model_dump(),
    )
    db.add(link)
    db.add(ActivityLog(user_id=current_user.id, asset_id=asset_id, action=ActivityAction.shared))
    db.commit()
    db.refresh(link)
    return link


@router.get("/assets/{asset_id}/shares", response_model=list[ShareLinkResponse])
def list_share_links(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = _get_asset(db, asset_id)
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)
    return db.query(ShareLink).filter(
        ShareLink.asset_id == asset_id,
        ShareLink.deleted_at.is_(None),
    ).all()


@router.get("/share/{token}", response_model=ShareLinkValidateResponse)
def validate_share_link_endpoint(
    token: str,
    password: Optional[str] = None,
    log_open: bool = False,
    db: Session = Depends(get_db),
):
    """Public endpoint — no auth required. Validates token and optional password."""
    link = validate_share_link(db, token)

    # Resolve folder name if this is a folder share
    folder_name = None
    if link.folder_id:
        folder = db.query(Folder).filter(Folder.id == link.folder_id, Folder.deleted_at.is_(None)).first()
        if folder:
            folder_name = folder.name

    if link.password_hash:
        if not password:
            return ShareLinkValidateResponse(
                requires_password=True,
                title=link.title,
                permission=link.permission,
            )
        try:
            plain_bytes = password[:72].encode('utf-8')
            hashed_bytes = link.password_hash.encode('utf-8')
            if not bcrypt.checkpw(plain_bytes, hashed_bytes):
                raise HTTPException(status_code=403, detail="Incorrect password")
        except ValueError:
            raise HTTPException(status_code=403, detail="Incorrect password")

    if log_open:
        _log_share_activity(db, link.id, ShareActivityAction.opened, actor_email="anonymous")

    return ShareLinkValidateResponse(
        asset_id=link.asset_id,
        folder_id=link.folder_id,
        folder_name=folder_name,
        title=link.title,
        description=link.description,
        permission=link.permission,
        allow_download=link.allow_download,
        show_versions=link.show_versions,
        show_watermark=link.show_watermark,
        appearance=link.appearance,
        requires_password=False,
    )


# ── Step 1: PATCH share link ─────────────────────────────────────────────────

@router.patch("/share/{token}", response_model=ShareLinkResponse)
def update_share_link(
    token: str,
    body: ShareLinkUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    link = db.query(ShareLink).filter(ShareLink.token == token, ShareLink.deleted_at.is_(None)).first()
    if not link:
        raise HTTPException(status_code=404, detail="Share link not found")
    project_id = _get_project_id_from_link(db, link)
    require_project_role(db, project_id, current_user, ProjectRole.editor)

    updates = body.model_dump(exclude_unset=True)

    # Handle password separately — hash it
    if "password" in updates:
        raw_password = updates.pop("password")
        if raw_password:
            pwd_bytes = raw_password[:72].encode('utf-8')
            salt = bcrypt.gensalt()
            link.password_hash = bcrypt.hashpw(pwd_bytes, salt).decode('utf-8')
        else:
            link.password_hash = None

    # Convert appearance Pydantic model to dict
    if "appearance" in updates and updates["appearance"] is not None:
        updates["appearance"] = body.appearance.model_dump()

    for key, value in updates.items():
        setattr(link, key, value)

    db.commit()
    db.refresh(link)
    return link


@router.delete("/share/{token}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_share_link(
    token: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    link = db.query(ShareLink).filter(ShareLink.token == token, ShareLink.deleted_at.is_(None)).first()
    if not link:
        raise HTTPException(status_code=404, detail="Share link not found")
    project_id = _get_project_id_from_link(db, link)
    require_project_role(db, project_id, current_user, ProjectRole.editor)
    link.deleted_at = datetime.now(timezone.utc)
    db.commit()


# ── Folder share links ───────────────────────────────────────────────────────

@router.post("/folders/{folder_id}/share", response_model=ShareLinkResponse, status_code=status.HTTP_201_CREATED)
def create_folder_share_link(
    folder_id: uuid.UUID,
    body: ShareLinkCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    folder = _get_folder(db, folder_id)
    require_project_role(db, folder.project_id, current_user, ProjectRole.editor)

    token = secrets.token_urlsafe(32)
    if body.password:
        pwd_bytes = body.password[:72].encode('utf-8')
        salt = bcrypt.gensalt()
        password_hash = bcrypt.hashpw(pwd_bytes, salt).decode('utf-8')
    else:
        password_hash = None

    link = ShareLink(
        folder_id=folder_id,
        token=token,
        created_by=current_user.id,
        title=body.title if body.title else folder.name,
        description=body.description,
        expires_at=body.expires_at,
        password_hash=password_hash,
        permission=body.permission,
        allow_download=body.allow_download,
        show_versions=body.show_versions,
        show_watermark=body.show_watermark,
        appearance=body.appearance.model_dump(),
    )
    db.add(link)
    db.commit()
    db.refresh(link)
    return link


@router.get("/folders/{folder_id}/shares", response_model=list[ShareLinkResponse])
def list_folder_share_links(
    folder_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    folder = _get_folder(db, folder_id)
    require_project_role(db, folder.project_id, current_user, ProjectRole.viewer)
    return db.query(ShareLink).filter(
        ShareLink.folder_id == folder_id,
        ShareLink.deleted_at.is_(None),
    ).all()


# ── Folder direct user/team sharing ──────────────────────────────────────────

@router.post("/folders/{folder_id}/share/user", response_model=DirectShareResponse, status_code=status.HTTP_201_CREATED)
def share_folder_with_user(
    folder_id: uuid.UUID,
    body: DirectShareCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not body.user_id:
        raise HTTPException(status_code=400, detail="user_id required")
    folder = _get_folder(db, folder_id)
    require_project_role(db, folder.project_id, current_user, ProjectRole.editor)

    # Upsert: reactivate if soft-deleted
    existing = db.query(AssetShare).filter(
        AssetShare.folder_id == folder_id,
        AssetShare.shared_with_user_id == body.user_id,
    ).first()
    if existing:
        if existing.deleted_at is None:
            existing.permission = body.permission
        else:
            existing.deleted_at = None
            existing.permission = body.permission
        db.commit()
        db.refresh(existing)
        return existing

    share = AssetShare(
        folder_id=folder_id,
        shared_with_user_id=body.user_id,
        permission=body.permission,
        shared_by=current_user.id,
    )
    db.add(share)
    db.commit()
    db.refresh(share)

    # Send share email
    shared_user = db.query(User).filter(User.id == body.user_id).first()
    if shared_user:
        folder_link = f"{settings.frontend_url}/folders/{folder_id}"
        send_share_email.delay(
            to_email=shared_user.email,
            sharer_name=current_user.name,
            asset_name=folder.name,
            asset_link=folder_link,
            permission=body.permission.value if body.permission else None,
        )

    return share


@router.post("/folders/{folder_id}/share/team", response_model=DirectShareResponse, status_code=status.HTTP_201_CREATED)
def share_folder_with_team(
    folder_id: uuid.UUID,
    body: DirectShareCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not body.team_id:
        raise HTTPException(status_code=400, detail="team_id required")
    folder = _get_folder(db, folder_id)
    require_project_role(db, folder.project_id, current_user, ProjectRole.editor)

    existing = db.query(AssetShare).filter(
        AssetShare.folder_id == folder_id,
        AssetShare.shared_with_team_id == body.team_id,
    ).first()
    if existing:
        if existing.deleted_at is None:
            existing.permission = body.permission
        else:
            existing.deleted_at = None
            existing.permission = body.permission
        db.commit()
        db.refresh(existing)
        return existing

    share = AssetShare(
        folder_id=folder_id,
        shared_with_team_id=body.team_id,
        permission=body.permission,
        shared_by=current_user.id,
    )
    db.add(share)
    db.commit()
    db.refresh(share)
    return share


# ── Delete folder share ──────────────────────────────────────────────────────

@router.delete("/folders/{folder_id}/shares/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_folder_share(
    folder_id: uuid.UUID,
    share_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    folder = _get_folder(db, folder_id)
    require_project_role(db, folder.project_id, current_user, ProjectRole.editor)

    share = db.query(AssetShare).filter(
        AssetShare.id == share_id,
        AssetShare.folder_id == folder_id,
        AssetShare.deleted_at.is_(None),
    ).first()
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")

    share.deleted_at = datetime.now(timezone.utc)
    db.commit()


# ── Direct user/team sharing (assets) ────────────────────────────────────────

@router.post("/assets/{asset_id}/share/user", response_model=DirectShareResponse, status_code=status.HTTP_201_CREATED)
def share_with_user(
    asset_id: uuid.UUID,
    body: DirectShareCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not body.user_id:
        raise HTTPException(status_code=400, detail="user_id required")
    asset = _get_asset(db, asset_id)
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    # Upsert: reactivate if soft-deleted
    existing = db.query(AssetShare).filter(
        AssetShare.asset_id == asset_id,
        AssetShare.shared_with_user_id == body.user_id,
    ).first()
    if existing:
        if existing.deleted_at is None:
            existing.permission = body.permission
        else:
            existing.deleted_at = None
            existing.permission = body.permission
        db.commit()
        db.refresh(existing)
        return existing

    share = AssetShare(
        asset_id=asset_id,
        shared_with_user_id=body.user_id,
        permission=body.permission,
        shared_by=current_user.id,
    )
    db.add(share)
    db.add(ActivityLog(user_id=current_user.id, asset_id=asset_id, action=ActivityAction.shared))
    db.commit()
    db.refresh(share)

    # Send share email
    shared_user = db.query(User).filter(User.id == body.user_id).first()
    if shared_user:
        asset_link = f"{settings.frontend_url}/assets/{asset_id}"
        send_share_email.delay(
            to_email=shared_user.email,
            sharer_name=current_user.name,
            asset_name=asset.name,
            asset_link=asset_link,
            permission=body.permission.value if body.permission else None,
        )

    return share


@router.post("/assets/{asset_id}/share/team", response_model=DirectShareResponse, status_code=status.HTTP_201_CREATED)
def share_with_team(
    asset_id: uuid.UUID,
    body: DirectShareCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not body.team_id:
        raise HTTPException(status_code=400, detail="team_id required")
    asset = _get_asset(db, asset_id)
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    existing = db.query(AssetShare).filter(
        AssetShare.asset_id == asset_id,
        AssetShare.shared_with_team_id == body.team_id,
    ).first()
    if existing:
        if existing.deleted_at is None:
            existing.permission = body.permission
        else:
            existing.deleted_at = None
            existing.permission = body.permission
        db.commit()
        db.refresh(existing)
        return existing

    share = AssetShare(
        asset_id=asset_id,
        shared_with_team_id=body.team_id,
        permission=body.permission,
        shared_by=current_user.id,
    )
    db.add(share)
    db.add(ActivityLog(user_id=current_user.id, asset_id=asset_id, action=ActivityAction.shared))
    db.commit()
    db.refresh(share)
    return share


# ── Project-level share link listing ──────────────────────────────────────────

@router.get("/projects/{project_id}/share-links", response_model=list[ShareLinkListItem])
def list_project_share_links(
    project_id: uuid.UUID,
    search: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.viewer)

    # Subquery for view_count and last_viewed_at
    activity_stats = db.query(
        ShareLinkActivity.share_link_id,
        sa_func.count(case((ShareLinkActivity.action == ShareActivityAction.opened, 1))).label("view_count"),
        sa_func.max(ShareLinkActivity.created_at).label("last_viewed_at"),
    ).group_by(ShareLinkActivity.share_link_id).subquery()

    # Asset share links
    asset_query = (
        db.query(
            ShareLink.id,
            ShareLink.token,
            ShareLink.title,
            ShareLink.description,
            ShareLink.is_enabled,
            ShareLink.permission,
            sa_func.literal("asset").label("share_type"),
            Asset.name.label("target_name"),
            sa_func.coalesce(activity_stats.c.view_count, 0).label("view_count"),
            activity_stats.c.last_viewed_at,
        )
        .join(Asset, ShareLink.asset_id == Asset.id)
        .outerjoin(activity_stats, ShareLink.id == activity_stats.c.share_link_id)
        .filter(
            Asset.project_id == project_id,
            ShareLink.deleted_at.is_(None),
            Asset.deleted_at.is_(None),
        )
    )

    # Folder share links
    folder_query = (
        db.query(
            ShareLink.id,
            ShareLink.token,
            ShareLink.title,
            ShareLink.description,
            ShareLink.is_enabled,
            ShareLink.permission,
            sa_func.literal("folder").label("share_type"),
            Folder.name.label("target_name"),
            sa_func.coalesce(activity_stats.c.view_count, 0).label("view_count"),
            activity_stats.c.last_viewed_at,
        )
        .join(Folder, ShareLink.folder_id == Folder.id)
        .outerjoin(activity_stats, ShareLink.id == activity_stats.c.share_link_id)
        .filter(
            Folder.project_id == project_id,
            ShareLink.deleted_at.is_(None),
            Folder.deleted_at.is_(None),
        )
    )

    if search:
        escaped = _escape_like(search)
        asset_query = asset_query.filter(ShareLink.title.ilike(f"%{escaped}%"))
        folder_query = folder_query.filter(ShareLink.title.ilike(f"%{escaped}%"))

    results = asset_query.union_all(folder_query).all()

    return [
        ShareLinkListItem(
            id=row.id,
            token=row.token,
            title=row.title,
            description=row.description,
            is_enabled=row.is_enabled,
            permission=row.permission,
            share_type=row.share_type,
            target_name=row.target_name,
            view_count=row.view_count,
            last_viewed_at=row.last_viewed_at,
        )
        for row in results
    ]


# ── Share link activity ───────────────────────────────────────────────────────

@router.get("/share/{token}/activity", response_model=list[ShareLinkActivityResponse])
def get_share_link_activity(
    token: str,
    page: int = 1,
    per_page: int = 50,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    link = db.query(ShareLink).filter(ShareLink.token == token, ShareLink.deleted_at.is_(None)).first()
    if not link:
        raise HTTPException(status_code=404, detail="Share link not found")
    project_id = _get_project_id_from_link(db, link)
    require_project_role(db, project_id, current_user, ProjectRole.viewer)

    offset = (page - 1) * per_page
    activities = db.query(ShareLinkActivity).filter(
        ShareLinkActivity.share_link_id == link.id,
    ).order_by(ShareLinkActivity.created_at.desc()).offset(offset).limit(per_page).all()
    return activities


# ── Folder share public endpoints ─────────────────────────────────────────────

@router.get("/share/{token}/assets", response_model=FolderShareAssetsResponse)
def get_folder_share_assets(
    token: str,
    folder_id: Optional[uuid.UUID] = None,
    page: int = 1,
    per_page: int = 50,
    db: Session = Depends(get_db),
):
    """Public endpoint — no auth required. Returns assets and subfolders for a folder share link."""
    link = validate_share_link(db, token)

    if not link.folder_id:
        raise HTTPException(status_code=400, detail="This share link is not a folder share")

    # Determine which folder to list contents from
    target_folder_id = link.folder_id
    if folder_id:
        # Validate the requested folder is a descendant of the shared folder
        if folder_id != link.folder_id and not _is_descendant_of(db, folder_id, link.folder_id):
            raise HTTPException(status_code=403, detail="Folder is not within the shared folder")
        target_folder_id = folder_id

    # Get subfolders
    subfolders_query = db.query(Folder).filter(
        Folder.parent_id == target_folder_id,
        Folder.deleted_at.is_(None),
    ).order_by(Folder.name).all()

    subfolder_items = []
    for sf in subfolders_query:
        # Count assets + direct child folders in this subfolder
        asset_count = db.query(sa_func.count(Asset.id)).filter(
            Asset.folder_id == sf.id,
            Asset.deleted_at.is_(None),
        ).scalar() or 0
        child_folder_count = db.query(sa_func.count(Folder.id)).filter(
            Folder.parent_id == sf.id,
            Folder.deleted_at.is_(None),
        ).scalar() or 0
        subfolder_items.append(FolderShareSubfolder(
            id=sf.id,
            name=sf.name,
            item_count=asset_count + child_folder_count,
        ))

    # Get assets in this folder
    total = db.query(sa_func.count(Asset.id)).filter(
        Asset.folder_id == target_folder_id,
        Asset.deleted_at.is_(None),
    ).scalar() or 0

    offset = (page - 1) * per_page
    assets = db.query(Asset).filter(
        Asset.folder_id == target_folder_id,
        Asset.deleted_at.is_(None),
    ).order_by(Asset.created_at.desc()).offset(offset).limit(per_page).all()

    asset_items = []
    for asset in assets:
        thumbnail_url = None
        file_size = None
        media_file = _get_latest_media_file(db, asset.id)
        if media_file:
            if media_file.s3_key_thumbnail:
                thumbnail_url = generate_presigned_get_url(media_file.s3_key_thumbnail)
            file_size = media_file.file_size_bytes
        asset_items.append(FolderShareAssetItem(
            id=asset.id,
            name=asset.name,
            asset_type=asset.asset_type.value,
            thumbnail_url=thumbnail_url,
            file_size=file_size,
            created_at=asset.created_at,
        ))

    return FolderShareAssetsResponse(
        assets=asset_items,
        subfolders=subfolder_items,
        total=total,
        page=page,
        per_page=per_page,
    )


@router.get("/share/{token}/stream/{asset_id}")
def get_share_stream_url(
    token: str,
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
):
    """Public endpoint — no auth required. Returns presigned stream URL for an asset in a share link."""
    link = validate_share_link(db, token)

    asset = _get_asset(db, asset_id)

    # Validate asset belongs to this share
    if link.folder_id:
        # Folder share: asset must be in the shared folder or a descendant
        if asset.folder_id != link.folder_id:
            if not asset.folder_id or not _is_descendant_of(db, asset.folder_id, link.folder_id):
                raise HTTPException(status_code=403, detail="Asset is not within the shared folder")
    elif link.asset_id:
        if asset.id != link.asset_id:
            raise HTTPException(status_code=403, detail="Asset does not match share link")
    else:
        raise HTTPException(status_code=400, detail="Invalid share link")

    media_file = _get_latest_media_file(db, asset.id)
    if not media_file:
        raise HTTPException(status_code=404, detail="No ready media file found")

    # Generate presigned URL (same pattern as assets.py stream endpoint)
    s3_key = media_file.s3_key_processed or media_file.s3_key_raw
    if asset.asset_type == AssetType.video and media_file.s3_key_processed:
        s3_key = f"{media_file.s3_key_processed}/master.m3u8"

    url = generate_presigned_get_url(s3_key)

    # Log viewed_asset activity
    _log_share_activity(
        db, link.id, ShareActivityAction.viewed_asset,
        actor_email="anonymous",
        asset_id=asset.id,
        asset_name=asset.name,
    )

    return {"url": url, "asset_type": asset.asset_type.value}


@router.get("/share/{token}/thumbnail/{asset_id}")
def get_share_thumbnail_url(
    token: str,
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
):
    """Public endpoint — no auth required. Returns presigned thumbnail URL for an asset in a share link."""
    link = validate_share_link(db, token)

    asset = _get_asset(db, asset_id)

    # Validate asset belongs to this share
    if link.folder_id:
        if asset.folder_id != link.folder_id:
            if not asset.folder_id or not _is_descendant_of(db, asset.folder_id, link.folder_id):
                raise HTTPException(status_code=403, detail="Asset is not within the shared folder")
    elif link.asset_id:
        if asset.id != link.asset_id:
            raise HTTPException(status_code=403, detail="Asset does not match share link")
    else:
        raise HTTPException(status_code=400, detail="Invalid share link")

    media_file = _get_latest_media_file(db, asset.id)
    if not media_file or not media_file.s3_key_thumbnail:
        raise HTTPException(status_code=404, detail="Thumbnail not found")

    url = generate_presigned_get_url(media_file.s3_key_thumbnail)
    return {"url": url}
