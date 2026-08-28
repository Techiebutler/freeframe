import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from datetime import datetime, timezone

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.asset import Asset
from ..models.approval import Approval, ApprovalStatus
from ..models.activity import ActivityLog, ActivityAction, Notification, NotificationType
from ..models.project import ProjectRole
from ..schemas.approval import ApprovalCreate, ApprovalResponse
from ..services.permissions import require_asset_access, require_project_role
from ..services import event_service
from ..tasks.email_tasks import send_approval_email
from ..tasks.celery_app import send_task_safe
from ..config import settings

router = APIRouter(tags=["approvals"])


def _get_asset(db: Session, asset_id: uuid.UUID) -> Asset:
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


def _upsert_approval(
    db: Session,
    asset: Asset,
    version_id: uuid.UUID,
    user: User,
    new_status: ApprovalStatus,
    note: str | None,
) -> Approval:
    """Create or update an approval record for a user+version."""
    existing = db.query(Approval).filter(
        Approval.asset_id == asset.id,
        Approval.version_id == version_id,
        Approval.user_id == user.id,
        Approval.deleted_at.is_(None),
    ).first()

    if existing:
        existing.status = new_status
        existing.note = note
        db.commit()
        db.refresh(existing)
        return existing

    approval = Approval(
        asset_id=asset.id,
        version_id=version_id,
        user_id=user.id,
        status=new_status,
        note=note,
    )
    db.add(approval)
    db.commit()
    db.refresh(approval)
    return approval


@router.post("/assets/{asset_id}/approve", response_model=ApprovalResponse)
def approve_asset(
    asset_id: uuid.UUID,
    body: ApprovalCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = _get_asset(db, asset_id)
    # reviewer or above can approve
    require_project_role(db, asset.project_id, current_user, ProjectRole.reviewer)

    approval = _upsert_approval(db, asset, body.version_id, current_user, ApprovalStatus.approved, body.note)

    # Activity + notification to asset creator
    db.add(ActivityLog(user_id=current_user.id, asset_id=asset_id, action=ActivityAction.approved))
    if asset.created_by != current_user.id:
        db.add(Notification(user_id=asset.created_by, type=NotificationType.approval, asset_id=asset_id))
        # Send approval email
        creator = db.query(User).filter(User.id == asset.created_by).first()
        if creator:
            asset_link = f"{settings.frontend_url}/assets/{asset_id}"
            send_task_safe(
                send_approval_email,
                to_email=creator.email,
                reviewer_name=current_user.name,
                asset_name=asset.name,
                status="approved",
                asset_link=asset_link,
                note=body.note,
            )
    db.commit()

    event_service.publish_sync(asset.project_id, "approval_updated", {
        "asset_id": str(asset_id),
        "user_id": str(current_user.id),
        "status": "approved",
    })

    return approval


@router.post("/assets/{asset_id}/reject", response_model=ApprovalResponse)
def reject_asset(
    asset_id: uuid.UUID,
    body: ApprovalCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = _get_asset(db, asset_id)
    require_project_role(db, asset.project_id, current_user, ProjectRole.reviewer)

    approval = _upsert_approval(db, asset, body.version_id, current_user, ApprovalStatus.rejected, body.note)

    db.add(ActivityLog(user_id=current_user.id, asset_id=asset_id, action=ActivityAction.rejected))
    if asset.created_by != current_user.id:
        db.add(Notification(user_id=asset.created_by, type=NotificationType.approval, asset_id=asset_id))
        # Send rejection email
        creator = db.query(User).filter(User.id == asset.created_by).first()
        if creator:
            asset_link = f"{settings.frontend_url}/assets/{asset_id}"
            send_task_safe(
                send_approval_email,
                to_email=creator.email,
                reviewer_name=current_user.name,
                asset_name=asset.name,
                status="rejected",
                asset_link=asset_link,
                note=body.note,
            )
    db.commit()

    event_service.publish_sync(asset.project_id, "approval_updated", {
        "asset_id": str(asset_id),
        "user_id": str(current_user.id),
        "status": "rejected",
    })

    return approval


@router.get("/assets/{asset_id}/approvals", response_model=list[ApprovalResponse])
def list_approvals(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = _get_asset(db, asset_id)
    require_asset_access(db, asset, current_user)
    return db.query(Approval).filter(
        Approval.asset_id == asset_id,
        Approval.deleted_at.is_(None),
    ).all()
