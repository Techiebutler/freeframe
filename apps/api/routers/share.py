import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
import bcrypt

from fastapi import APIRouter, Depends, HTTPException, Query, status
import sqlalchemy
from sqlalchemy import func as sa_func, case
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user, get_optional_user
from ..middleware.rate_limit import rate_limit
from ..models.user import User
from ..models.asset import Asset
from ..models.folder import Folder
from ..models.share import AssetShare, ShareLink, SharePermission, ShareLinkActivity, ShareActivityAction
from ..models.activity import ActivityLog, ActivityAction
from ..models.branding import ProjectBranding
from ..models.asset import AssetVersion, AssetType, MediaFile, ProcessingStatus
from ..models.comment import Comment
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
from ..services.permissions import require_project_role, validate_share_link, validate_share_link_with_session
from ..services.redis_service import create_share_session
from ..services.s3_service import generate_presigned_get_url
from ..services.crypto_service import encrypt_password, decrypt_password
from ..models.project import Project, ProjectRole
from ..tasks.email_tasks import send_share_email
from ..tasks.celery_app import send_task_safe
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
    if link.project_id:
        return link.project_id
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
    dedup_seconds: int = 30,
):
    """Log share activity, skipping duplicates within dedup_seconds window."""
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=dedup_seconds)
        existing = db.query(ShareLinkActivity).filter(
            ShareLinkActivity.share_link_id == share_link_id,
            ShareLinkActivity.action == action,
            ShareLinkActivity.actor_email == actor_email,
            ShareLinkActivity.asset_id == asset_id,
            ShareLinkActivity.created_at >= cutoff,
        ).first()
        if existing:
            return
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
        password_encrypted = encrypt_password(body.password)
    else:
        password_hash = None
        password_encrypted = None

    link = ShareLink(
        asset_id=asset_id,
        token=token,
        created_by=current_user.id,
        title=body.title if body.title else asset.name,
        description=body.description,
        expires_at=body.expires_at,
        password_hash=password_hash,
        password_encrypted=password_encrypted,
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


@router.get("/share/{token}", response_model=ShareLinkValidateResponse, dependencies=[Depends(rate_limit("share_validate", 30, 60))])
def validate_share_link_endpoint(
    token: str,
    password: Optional[str] = None,
    log_open: bool = False,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_user),
):
    """Public endpoint — optional auth. For secure links, requires authenticated user."""
    link = validate_share_link(db, token)

    # Check secure visibility — requires authenticated user
    if link.visibility == "secure":
        if not current_user:
            return ShareLinkValidateResponse(
                requires_auth=True,
                requires_password=False,
                title=link.title,
                permission=link.permission,
                visibility=link.visibility,
            )

    # Resolve folder name if this is a folder share
    folder_name = None
    project_name = None
    if link.folder_id:
        folder = db.query(Folder).filter(Folder.id == link.folder_id, Folder.deleted_at.is_(None)).first()
        if folder:
            folder_name = folder.name
    if link.project_id:
        project = db.query(Project).filter(Project.id == link.project_id, Project.deleted_at.is_(None)).first()
        if project:
            project_name = project.name

    session_id = None
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
        # Password verified — create a session so subsequent requests skip re-verification
        session_id = secrets.token_urlsafe(32)
        create_share_session(token, session_id)

    if log_open:
        actor_email = current_user.email if current_user else "anonymous"
        actor_name = current_user.name if current_user else None
        _log_share_activity(db, link.id, ShareActivityAction.opened, actor_email=actor_email, actor_name=actor_name)

    # Build asset details for asset shares
    asset_data = None
    branding_data = None
    if link.asset_id:
        asset = _get_asset(db, link.asset_id)
        # Get thumbnail URL
        media_file = _get_latest_media_file(db, asset.id)
        thumbnail_url = None
        if media_file and media_file.s3_key_thumbnail:
            thumbnail_url = generate_presigned_get_url(media_file.s3_key_thumbnail)
        # Get stream URL
        stream_url = None
        if media_file:
            if media_file.s3_key_processed:
                stream_url = generate_presigned_get_url(media_file.s3_key_processed)
            elif media_file.s3_key_raw:
                stream_url = generate_presigned_get_url(media_file.s3_key_raw)

        asset_data = {
            "id": str(asset.id),
            "name": asset.name,
            "asset_type": asset.asset_type.value if hasattr(asset.asset_type, 'value') else str(asset.asset_type),
            "description": asset.description,
            "thumbnail_url": thumbnail_url,
            "stream_url": stream_url,
        }
        # Get project branding
        branding = db.query(ProjectBranding).filter(
            ProjectBranding.project_id == asset.project_id
        ).first()
        if branding:
            branding_data = {
                "logo_url": branding.logo_s3_key,
                "primary_color": branding.primary_color,
                "custom_title": branding.custom_title,
                "custom_footer": branding.custom_footer,
            }

    # Resolve creator name
    creator = db.query(User).filter(User.id == link.created_by).first()
    created_by_name = creator.name if creator else None

    return ShareLinkValidateResponse(
        asset_id=link.asset_id,
        folder_id=link.folder_id,
        project_id=link.project_id,
        folder_name=folder_name,
        project_name=project_name,
        title=link.title,
        description=link.description,
        permission=link.permission,
        visibility=link.visibility,
        allow_download=link.allow_download,
        show_versions=link.show_versions,
        show_watermark=link.show_watermark,
        appearance=link.appearance,
        requires_password=False,
        created_by_name=created_by_name,
        viewer_name=current_user.name if current_user else None,
        viewer_email=current_user.email if current_user else None,
        asset=asset_data,
        branding=branding_data,
        share_session=session_id,
    )


def _share_link_response(link: ShareLink) -> ShareLinkResponse:
    """Build ShareLinkResponse from ORM model, computing has_password and decrypting password."""
    response = ShareLinkResponse.model_validate(link)
    response.has_password = link.password_hash is not None and link.password_hash != ''
    if link.password_encrypted:
        try:
            response.password_value = decrypt_password(link.password_encrypted)
        except Exception:
            response.password_value = None
    return response


# ── Authenticated share link details (for settings panel) ────────────────────

@router.get("/share/{token}/details", response_model=ShareLinkResponse)
def get_share_link_details(
    token: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Authenticated endpoint returning full share link details for the settings panel."""
    link = db.query(ShareLink).filter(
        ShareLink.token == token,
        ShareLink.deleted_at.is_(None),
    ).first()
    if not link:
        raise HTTPException(status_code=404, detail="Share link not found")
    project_id = _get_project_id_from_link(db, link)
    require_project_role(db, project_id, current_user, ProjectRole.viewer)
    return _share_link_response(link)


# ── PATCH share link ─────────────────────────────────────────────────────────

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

    # Handle password separately — hash + encrypt for reversible admin display
    if "password" in updates:
        raw_password = updates.pop("password")
        if raw_password:
            pwd_bytes = raw_password[:72].encode('utf-8')
            salt = bcrypt.gensalt()
            link.password_hash = bcrypt.hashpw(pwd_bytes, salt).decode('utf-8')
            link.password_encrypted = encrypt_password(raw_password)
        else:
            link.password_hash = None
            link.password_encrypted = None

    # Convert appearance Pydantic model to dict
    if "appearance" in updates and updates["appearance"] is not None:
        updates["appearance"] = body.appearance.model_dump()

    for key, value in updates.items():
        setattr(link, key, value)

    db.commit()
    db.refresh(link)
    return _share_link_response(link)


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
        password_encrypted = encrypt_password(body.password)
    else:
        password_hash = None
        password_encrypted = None

    link = ShareLink(
        folder_id=folder_id,
        token=token,
        created_by=current_user.id,
        title=body.title if body.title else folder.name,
        description=body.description,
        expires_at=body.expires_at,
        password_hash=password_hash,
        password_encrypted=password_encrypted,
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


@router.post("/projects/{project_id}/share", response_model=ShareLinkResponse, status_code=status.HTTP_201_CREATED)
def create_project_share_link(
    project_id: uuid.UUID,
    body: ShareLinkCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a share link for the project root (all root-level folders and assets)."""
    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_role(db, project_id, current_user, ProjectRole.editor)

    token = secrets.token_urlsafe(32)
    if body.password:
        pwd_bytes = body.password[:72].encode('utf-8')
        salt = bcrypt.gensalt()
        password_hash = bcrypt.hashpw(pwd_bytes, salt).decode('utf-8')
        password_encrypted = encrypt_password(body.password)
    else:
        password_hash = None
        password_encrypted = None

    link = ShareLink(
        project_id=project_id,
        token=token,
        created_by=current_user.id,
        title=body.title if body.title else project.name,
        description=body.description,
        expires_at=body.expires_at,
        password_hash=password_hash,
        password_encrypted=password_encrypted,
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


@router.post("/projects/{project_id}/share/user", response_model=DirectShareResponse, status_code=status.HTTP_201_CREATED)
def share_project_with_user(
    project_id: uuid.UUID,
    body: DirectShareCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Share entire project with a user by email or user_id. Sends notification email."""
    user_id = body.user_id
    if not user_id and body.email:
        from ..services.auth_service import get_user_by_email
        user = get_user_by_email(db, body.email)
        if user:
            user_id = user.id
        else:
            raise HTTPException(status_code=404, detail="User not found with that email")
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id or email required")

    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_role(db, project_id, current_user, ProjectRole.editor)

    # For project shares, we store as an AssetShare with project_id context
    # Use the first root folder or create a project-level share
    # Send notification email
    shared_user = db.query(User).filter(User.id == user_id).first()
    if shared_user:
        if body.share_token:
            project_link = f"{settings.frontend_url}/share/{body.share_token}"
        else:
            project_link = f"{settings.frontend_url}/projects/{project_id}"
        send_task_safe(send_share_email,
            to_email=shared_user.email,
            sharer_name=current_user.name or current_user.email,
            asset_name=project.name,
            asset_link=project_link,
            permission=body.permission.value if body.permission else None,
        )

    return DirectShareResponse(
        id=uuid.uuid4(),
        asset_id=None,
        folder_id=None,
        shared_with_user_id=user_id,
        shared_with_team_id=None,
        permission=body.permission or "view",
        shared_by=current_user.id,
        created_at=datetime.now(timezone.utc),
    )


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
    # Resolve user_id from email if not provided
    user_id = body.user_id
    if not user_id and body.email:
        from ..services.auth_service import get_user_by_email
        user = get_user_by_email(db, body.email)
        if user:
            user_id = user.id
        else:
            raise HTTPException(status_code=404, detail="User not found with that email")
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id or email required")

    folder = _get_folder(db, folder_id)
    require_project_role(db, folder.project_id, current_user, ProjectRole.editor)

    # Upsert: reactivate if soft-deleted
    existing = db.query(AssetShare).filter(
        AssetShare.folder_id == folder_id,
        AssetShare.shared_with_user_id == user_id,
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
        shared_with_user_id=user_id,
        permission=body.permission,
        shared_by=current_user.id,
    )
    db.add(share)
    db.commit()
    db.refresh(share)

    # Send share email
    shared_user = db.query(User).filter(User.id == user_id).first()
    if shared_user:
        if body.share_token:
            folder_link = f"{settings.frontend_url}/share/{body.share_token}"
        else:
            folder_link = f"{settings.frontend_url}/projects/{folder.project_id}?folder={folder_id}"
        send_task_safe(send_share_email,
            to_email=shared_user.email,
            sharer_name=current_user.name or current_user.email,
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

@router.get("/folders/{folder_id}/direct-shares")
def list_folder_direct_shares(
    folder_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List direct user shares for a folder."""
    folder = _get_folder(db, folder_id)
    require_project_role(db, folder.project_id, current_user, ProjectRole.viewer)
    shares = db.query(AssetShare).filter(
        AssetShare.folder_id == folder_id,
        AssetShare.deleted_at.is_(None),
        AssetShare.shared_with_user_id.isnot(None),
    ).all()
    return [{"id": str(s.id), "shared_with_user_id": str(s.shared_with_user_id), "permission": s.permission.value} for s in shares]


@router.get("/assets/{asset_id}/direct-shares")
def list_asset_direct_shares(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List direct user shares for an asset."""
    asset = _get_asset(db, asset_id)
    require_project_role(db, asset.project_id, current_user, ProjectRole.viewer)
    shares = db.query(AssetShare).filter(
        AssetShare.asset_id == asset_id,
        AssetShare.deleted_at.is_(None),
        AssetShare.shared_with_user_id.isnot(None),
    ).all()
    return [{"id": str(s.id), "shared_with_user_id": str(s.shared_with_user_id), "permission": s.permission.value} for s in shares]


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
    # Resolve user_id from email if not provided
    user_id = body.user_id
    if not user_id and body.email:
        from ..services.auth_service import get_user_by_email
        user = get_user_by_email(db, body.email)
        if user:
            user_id = user.id
        else:
            raise HTTPException(status_code=404, detail="User not found with that email")
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id or email required")

    asset = _get_asset(db, asset_id)
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    # Upsert: reactivate if soft-deleted
    existing = db.query(AssetShare).filter(
        AssetShare.asset_id == asset_id,
        AssetShare.shared_with_user_id == user_id,
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
        shared_with_user_id=user_id,
        permission=body.permission,
        shared_by=current_user.id,
    )
    db.add(share)
    db.add(ActivityLog(user_id=current_user.id, asset_id=asset_id, action=ActivityAction.shared))
    db.commit()
    db.refresh(share)

    # Send share email
    shared_user = db.query(User).filter(User.id == user_id).first()
    if shared_user:
        # Use share link URL if token provided, otherwise internal URL
        if body.share_token:
            asset_link = f"{settings.frontend_url}/share/{body.share_token}"
        else:
            asset_link = f"{settings.frontend_url}/projects/{asset.project_id}/assets/{asset_id}"
        send_task_safe(send_share_email,
            to_email=shared_user.email,
            sharer_name=current_user.name or current_user.email,
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
            sqlalchemy.literal("asset").label("share_type"),
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
            sqlalchemy.literal("folder").label("share_type"),
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

    # Project root share links
    project_query = (
        db.query(
            ShareLink.id,
            ShareLink.token,
            ShareLink.title,
            ShareLink.description,
            ShareLink.is_enabled,
            ShareLink.permission,
            sqlalchemy.literal("folder").label("share_type"),
            ShareLink.title.label("target_name"),
            sa_func.coalesce(activity_stats.c.view_count, 0).label("view_count"),
            activity_stats.c.last_viewed_at,
        )
        .outerjoin(activity_stats, ShareLink.id == activity_stats.c.share_link_id)
        .filter(
            ShareLink.project_id == project_id,
            ShareLink.deleted_at.is_(None),
        )
    )

    if search:
        escaped = _escape_like(search)
        asset_query = asset_query.filter(ShareLink.title.ilike(f"%{escaped}%"))
        folder_query = folder_query.filter(ShareLink.title.ilike(f"%{escaped}%"))
        project_query = project_query.filter(ShareLink.title.ilike(f"%{escaped}%"))

    results = asset_query.union_all(folder_query).union_all(project_query).all()

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


# ── Add asset to existing share link ──────────────────────────────────────────

@router.post("/share/{token}/add-asset/{asset_id}", status_code=status.HTTP_200_OK)
def add_asset_to_share_link(
    token: str,
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add an asset to an existing share link. Converts single-asset links to project-level."""
    link = db.query(ShareLink).filter(
        ShareLink.token == token,
        ShareLink.deleted_at.is_(None),
    ).first()
    if not link:
        raise HTTPException(status_code=404, detail="Share link not found")

    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    # Determine the share link's project
    link_project_id = _get_project_id_from_link(db, link)

    # Ensure caller has editor role
    if link_project_id:
        require_project_role(db, link_project_id, current_user, ProjectRole.editor)

    # Ensure the asset belongs to the same project
    if link_project_id and asset.project_id != link_project_id:
        raise HTTPException(status_code=403, detail="Asset does not belong to this share link's project")

    # Check if asset is already the direct target
    if link.asset_id == asset_id:
        return {"detail": "Asset already included in this share link"}

    # If this is a single-asset share link, convert to project-level share
    if link.asset_id and not link.project_id:
        link.project_id = link_project_id
        link.asset_id = None
        db.flush()

    # If this is a folder-only share, convert to project-level
    if link.folder_id and not link.project_id:
        link.project_id = link_project_id
        link.folder_id = None
        db.flush()

    # Set project_id if not yet set
    if not link.project_id:
        link.project_id = link_project_id or asset.project_id
        db.flush()

    db.commit()
    return {"detail": "Asset added to share link"}


# ── Folder share public endpoints ─────────────────────────────────────────────

@router.get("/share/{token}/assets", response_model=FolderShareAssetsResponse)
def get_folder_share_assets(
    token: str,
    folder_id: Optional[uuid.UUID] = None,
    page: int = 1,
    per_page: int = 50,
    share_session: Optional[str] = Query(None, alias="share_session"),
    db: Session = Depends(get_db),
):
    """Public endpoint — no auth required. Returns assets and subfolders for a folder or project share link."""
    link = validate_share_link_with_session(db, token, share_session=share_session)

    is_project_share = link.project_id is not None
    if not link.folder_id and not is_project_share:
        raise HTTPException(status_code=400, detail="This share link is not a folder or project share")

    # Determine which folder to list contents from
    # For project shares, target_folder_id=None means project root
    target_folder_id = link.folder_id  # None for project root shares
    if folder_id:
        if is_project_share:
            # Project share: validate folder belongs to this project
            f = db.query(Folder).filter(Folder.id == folder_id, Folder.deleted_at.is_(None)).first()
            if not f or f.project_id != link.project_id:
                raise HTTPException(status_code=403, detail="Folder is not within the shared project")
        elif folder_id != link.folder_id and not _is_descendant_of(db, folder_id, link.folder_id):
            raise HTTPException(status_code=403, detail="Folder is not within the shared folder")
        target_folder_id = folder_id

    # Get subfolders
    if target_folder_id:
        subfolder_filter = Folder.parent_id == target_folder_id
    else:
        # Project root: folders with no parent in this project
        subfolder_filter = sqlalchemy.and_(
            Folder.parent_id.is_(None),
            Folder.project_id == link.project_id,
        )
    subfolders_query = db.query(Folder).filter(
        subfolder_filter,
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

        # Fetch up to 4 thumbnail previews from assets inside this subfolder
        thumb_urls: list[str] = []
        preview_assets = db.query(Asset).filter(
            Asset.folder_id == sf.id,
            Asset.deleted_at.is_(None),
        ).order_by(Asset.created_at.desc()).limit(4).all()
        for pa in preview_assets:
            mf = _get_latest_media_file(db, pa.id)
            if mf and mf.s3_key_thumbnail:
                thumb_urls.append(generate_presigned_get_url(mf.s3_key_thumbnail))
            if len(thumb_urls) >= 4:
                break

        subfolder_items.append(FolderShareSubfolder(
            id=sf.id,
            name=sf.name,
            item_count=asset_count + child_folder_count,
            thumbnail_urls=thumb_urls,
        ))

    # Get assets in this folder (or project root if target_folder_id is None)
    if target_folder_id:
        asset_filter = Asset.folder_id == target_folder_id
    else:
        # Project root: assets with no folder in this project
        asset_filter = sqlalchemy.and_(
            Asset.folder_id.is_(None),
            Asset.project_id == link.project_id,
        )
    total = db.query(sa_func.count(Asset.id)).filter(
        asset_filter,
        Asset.deleted_at.is_(None),
    ).scalar() or 0

    offset = (page - 1) * per_page
    assets = db.query(Asset).filter(
        asset_filter,
        Asset.deleted_at.is_(None),
    ).order_by(Asset.created_at.desc()).offset(offset).limit(per_page).all()

    asset_items = []
    for asset in assets:
        thumbnail_url = None
        file_size = None
        duration_seconds = None
        media_file = _get_latest_media_file(db, asset.id)
        if media_file:
            if media_file.s3_key_thumbnail:
                thumbnail_url = generate_presigned_get_url(media_file.s3_key_thumbnail)
            file_size = media_file.file_size_bytes
            duration_seconds = media_file.duration_seconds

        comment_count = db.query(sa_func.count(Comment.id)).filter(
            Comment.asset_id == asset.id,
            Comment.deleted_at.is_(None),
        ).scalar() or 0

        # Get creator name
        creator = db.query(User).filter(User.id == asset.created_by).first() if asset.created_by else None

        asset_items.append(FolderShareAssetItem(
            id=asset.id,
            name=asset.name,
            asset_type=asset.asset_type.value,
            thumbnail_url=thumbnail_url,
            file_size=file_size,
            duration_seconds=duration_seconds,
            comment_count=comment_count,
            created_by_name=creator.name if creator else None,
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
    share_session: Optional[str] = Query(None, alias="share_session"),
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_user),
):
    """Public endpoint — optional auth. Returns presigned stream URL for an asset in a share link."""
    link = validate_share_link_with_session(db, token, share_session=share_session, current_user=current_user)

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
    elif link.project_id:
        # Project root share: asset must belong to this project
        if asset.project_id != link.project_id:
            raise HTTPException(status_code=403, detail="Asset is not within the shared project")
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
        actor_email=current_user.email if current_user else "anonymous",
        actor_name=current_user.name if current_user else None,
        asset_id=asset.id,
        asset_name=asset.name,
    )

    # Get thumbnail URL
    thumb_url = None
    if media_file.s3_key_thumbnail:
        thumb_url = generate_presigned_get_url(media_file.s3_key_thumbnail)

    return {
        "url": url,
        "asset_type": asset.asset_type.value,
        "name": asset.name,
        "version_id": str(media_file.version_id) if media_file.version_id else None,
        "thumbnail_url": thumb_url,
        "duration_seconds": media_file.duration_seconds,
    }


@router.get("/share/{token}/thumbnail/{asset_id}")
def get_share_thumbnail_url(
    token: str,
    asset_id: uuid.UUID,
    share_session: Optional[str] = Query(None, alias="share_session"),
    db: Session = Depends(get_db),
):
    """Public endpoint — no auth required. Returns presigned thumbnail URL for an asset in a share link."""
    link = validate_share_link_with_session(db, token, share_session=share_session)

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
