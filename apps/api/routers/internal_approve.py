"""Server-to-server: Alan's "Approve anyway" in a Gen ADI lands as the owner's approval here (review bridge secret).

Not the agent route: no agent key can reach it, so "agents never approve" stays hard. Same effect as the owner pressing
Approve, plus the delivery step (spec docs/superpowers/specs/2026-11-20-ar-approve-via-adi.md).
"""
import hmac
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models.activity import ActivityAction, ActivityLog
from ..models.approval import Approval, ApprovalStatus
from ..models.asset import Asset, AssetVersion
from ..models.project import Project
from ..models.user import User
from ..services import deliveries, feedback_rounds

router = APIRouter(tags=['internal-approve'])


def _bridge(authorization: Optional[str] = Header(default=None)) -> None:
    """503 when the secret is unset, 403 (the spec's code, not the 401 of the read-only bridge routes) when it is wrong."""
    secret = settings.review_bridge_secret.strip()
    if not secret:
        raise HTTPException(503, 'Review bridge is not configured')
    if not hmac.compare_digest((authorization or '').encode(), f'Bearer {secret}'.encode()):
        raise HTTPException(403, 'Invalid review bridge credentials')


class AdiApprove(BaseModel):
    version_id: uuid.UUID
    decided_by: str = Field(min_length=3, max_length=255)
    decided_via: Literal['adi']
    decision_id: str = Field(min_length=1, max_length=120)


@router.post('/internal/assets/{asset_id}/approve', include_in_schema=False, dependencies=[Depends(_bridge)])
def adi_approve(asset_id: uuid.UUID, body: AdiApprove, db: Session = Depends(get_db)):
    from .approvals import _upsert_approval
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if asset is None:
        raise HTTPException(404, {'error': 'not_found'})
    owner = db.query(User).join(Project, Project.created_by == User.id).filter(Project.id == asset.project_id).first()
    if owner is None or owner.email.strip().lower() != body.decided_by.strip().lower():
        raise HTTPException(403, {'error': 'not_owner'})
    current = (db.query(AssetVersion.id).filter(AssetVersion.asset_id == asset.id, AssetVersion.deleted_at.is_(None))
               .order_by(AssetVersion.version_number.desc()).first())
    if current is None or current[0] != body.version_id:
        raise HTTPException(409, {'error': 'version_moved', 'current_version_id': str(current[0]) if current else None})
    already = db.query(Approval.id).filter(Approval.asset_id == asset.id, Approval.version_id == body.version_id, Approval.user_id == owner.id,
                                           Approval.status == ApprovalStatus.approved, Approval.deleted_at.is_(None)).first()
    if not already:  # a repeat adds no second row, no second activity, and keeps the first note
        _upsert_approval(db, asset, body.version_id, owner, ApprovalStatus.approved, f'adi:{body.decision_id}')
        db.add(ActivityLog(user_id=owner.id, asset_id=asset.id, action=ActivityAction.approved))
        db.commit()
    delivery = deliveries.out(deliveries.on_approved(db, asset, body.version_id, owner))
    return {'asset_id': str(asset.id), 'version_id': str(body.version_id), 'status': 'approved', 'delivery': delivery,
            'parts': deliveries.progress(db, feedback_rounds.request_for_asset(db, asset.id))}
