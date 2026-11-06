"""Approve from a share link: Alan reviews on his phone through a folder link and approves right there."""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_optional_user
from ..middleware.rate_limit import rate_limit
from ..models.activity import ActivityAction, ActivityLog
from ..models.approval import ApprovalStatus
from ..models.asset import Asset, AssetVersion
from ..models.share import SharePermission
from ..models.user import User
from ..services.permissions import validate_asset_in_share, validate_share_link_with_session

router = APIRouter(tags=["share"])


class ShareApprove(BaseModel):
    version_id: Optional[uuid.UUID] = None


def _approvable_asset(db: Session, token: str, asset_id: uuid.UUID, share_session, current_user):
    """The link and asset an approve/undo through `token` may touch; the same gates for both."""
    link = validate_share_link_with_session(db, token, share_session=share_session, current_user=current_user)
    if link.permission != SharePermission.approve:
        raise HTTPException(403, "approve_not_allowed")
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if asset is None:
        raise HTTPException(404, "not_found")
    try:
        validate_asset_in_share(db, link, asset)
    except HTTPException:
        raise HTTPException(404, "not_found")
    return link, asset


@router.delete("/share/{token}/assets/{asset_id}/approve", status_code=204, dependencies=[Depends(rate_limit("share_approve", 30, 600))])
def share_unapprove(token: str, asset_id: uuid.UUID, version_id: Optional[uuid.UUID] = None, share_session: Optional[str] = Query(None),
                    db: Session = Depends(get_db), current_user: Optional[User] = Depends(get_optional_user)):
    """Take the approval back (the link creator's, as recorded by the approve). Idempotent."""
    from .approvals import remove_approval
    link, asset = _approvable_asset(db, token, asset_id, share_session, current_user)
    remove_approval(db, asset, link.created_by, version_id)
    return Response(status_code=204)


@router.post("/share/{token}/assets/{asset_id}/approve", dependencies=[Depends(rate_limit("share_approve", 30, 600))])
def share_approve(token: str, asset_id: uuid.UUID, body: ShareApprove, share_session: Optional[str] = Query(None),
                  db: Session = Depends(get_db), current_user: Optional[User] = Depends(get_optional_user)):
    """A guest has no user row, so the approval is recorded for the link's creator: the person who made the
    link `approve` is the one approving through it."""
    from .approvals import _upsert_approval
    link, asset = _approvable_asset(db, token, asset_id, share_session, current_user)
    versions = db.query(AssetVersion).filter(AssetVersion.asset_id == asset.id, AssetVersion.deleted_at.is_(None))
    version = (versions.filter(AssetVersion.id == body.version_id).first() if body.version_id
               else versions.order_by(AssetVersion.version_number.desc()).first())
    if version is None:
        raise HTTPException(404, "not_found")
    _upsert_approval(db, asset, version.id, db.get(User, link.created_by), ApprovalStatus.approved, None)
    db.add(ActivityLog(user_id=link.created_by, asset_id=asset.id, action=ActivityAction.approved))
    db.commit()
    return {"asset_id": str(asset.id), "version_id": str(version.id), "status": "approved"}


@router.post("/share/{token}/assets/{asset_id}/feedback-done", status_code=204, dependencies=[Depends(rate_limit("share_feedback_done", 30, 600))])
def share_feedback_done(token: str, asset_id: uuid.UUID, share_session: Optional[str] = Query(None),
                        db: Session = Depends(get_db), current_user: Optional[User] = Depends(get_optional_user)):
    """The reviewer pressed Send: close the open feedback round now, so the agent starts at once instead of
    after 5 idle minutes. No open round (no agent request, already closed) is fine: nothing to do."""
    from datetime import datetime, timezone
    from ..services import feedback_rounds
    link = validate_share_link_with_session(db, token, share_session=share_session, current_user=current_user)
    if link.permission == SharePermission.view:
        raise HTTPException(403, "comment_not_allowed")
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if asset is None:
        raise HTTPException(404, "not_found")
    try:
        validate_asset_in_share(db, link, asset)
    except HTTPException:
        raise HTTPException(404, "not_found")
    req = feedback_rounds.request_for_asset(db, asset.id)
    rnd = feedback_rounds.open_round(db, req.id, lock=True) if req else None
    if rnd is not None:
        feedback_rounds.close_round(db, rnd, "button", datetime.now(timezone.utc))
    return Response(status_code=204)
