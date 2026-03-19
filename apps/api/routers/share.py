import secrets
import uuid
from datetime import datetime, timezone
from typing import Optional
import bcrypt

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.asset import Asset
from ..models.share import AssetShare, ShareLink, SharePermission
from ..models.activity import ActivityLog, ActivityAction
from ..schemas.share import (
    DirectShareCreate,
    DirectShareResponse,
    ShareLinkCreate,
    ShareLinkResponse,
    ShareLinkValidateResponse,
)
from ..services.permissions import require_project_role, validate_share_link
from ..models.project import ProjectRole
from ..tasks.email_tasks import send_share_email
from ..config import settings

router = APIRouter(tags=["sharing"])


def _get_asset(db: Session, asset_id: uuid.UUID) -> Asset:
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


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
        expires_at=body.expires_at,
        password_hash=password_hash,
        permission=body.permission,
        allow_download=body.allow_download,
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
    db: Session = Depends(get_db),
):
    """Public endpoint — no auth required. Validates token and optional password."""
    link = validate_share_link(db, token)

    if link.password_hash:
        if not password:
            return ShareLinkValidateResponse(
                asset_id=link.asset_id,
                permission=link.permission,
                allow_download=link.allow_download,
                requires_password=True,
            )
        try:
            plain_bytes = password[:72].encode('utf-8')
            hashed_bytes = link.password_hash.encode('utf-8')
            if not bcrypt.checkpw(plain_bytes, hashed_bytes):
                raise HTTPException(status_code=403, detail="Incorrect password")
        except ValueError:
            raise HTTPException(status_code=403, detail="Incorrect password")

    return ShareLinkValidateResponse(
        asset_id=link.asset_id,
        permission=link.permission,
        allow_download=link.allow_download,
        requires_password=False,
    )


@router.delete("/share/{token}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_share_link(
    token: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    link = db.query(ShareLink).filter(ShareLink.token == token, ShareLink.deleted_at.is_(None)).first()
    if not link:
        raise HTTPException(status_code=404, detail="Share link not found")
    asset = _get_asset(db, link.asset_id)
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)
    link.deleted_at = datetime.now(timezone.utc)
    db.commit()


# ── Direct user/team sharing ──────────────────────────────────────────────────

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
