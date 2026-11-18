"""Approve from a share link: Alan reviews on his phone through a folder link and approves right there."""
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
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
from ..services import client_view, deliveries, feedback_rounds
from ..services.permissions import validate_asset_in_share, validate_share_link_with_session

router = APIRouter(tags=["share"])


class ShareApprove(BaseModel):
    version_id: Optional[uuid.UUID] = None


def _approvable_asset(db: Session, token: str, asset_id: uuid.UUID, share_session, current_user, authorization=None):
    """The link, asset and approver an approve/undo through `token` may touch; the same gates for both.
    Signed-in Aditor staff approve on any link as themselves (V3); others only on an `approve` link, as its
    creator. An agent never approves here (the agent route's rule, routers/agent.py)."""
    link = validate_share_link_with_session(db, token, share_session=share_session, current_user=current_user)
    # An agent key (`ara_…`) is no JWT, so it would otherwise pass as an anonymous guest.
    if (authorization or "").startswith("Bearer ara_") or getattr(current_user, "kind", "human") == "agent":
        raise HTTPException(403, "agents_may_not_approve")
    staff = client_view.viewer_is_staff(current_user)
    if not staff and link.permission != SharePermission.approve:
        raise HTTPException(403, "approve_not_allowed")
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if asset is None:
        raise HTTPException(404, "not_found")
    try:
        validate_asset_in_share(db, link, asset)
    except HTTPException:
        raise HTTPException(404, "not_found")
    return link, asset, (current_user.id if staff else link.created_by)


@router.delete("/share/{token}/assets/{asset_id}/approve", status_code=204, dependencies=[Depends(rate_limit("share_approve", 30, 600))])
def share_unapprove(token: str, asset_id: uuid.UUID, version_id: Optional[uuid.UUID] = None, share_session: Optional[str] = Query(None),
                    db: Session = Depends(get_db), current_user: Optional[User] = Depends(get_optional_user),
                    authorization: Optional[str] = Header(None)):
    """Take the approval back (the approver's, as recorded by the approve). Idempotent."""
    from .approvals import remove_approval
    _, asset, approver = _approvable_asset(db, token, asset_id, share_session, current_user, authorization)
    remove_approval(db, asset, approver, version_id)
    return Response(status_code=204)


@router.post("/share/{token}/assets/{asset_id}/approve", dependencies=[Depends(rate_limit("share_approve", 30, 600))])
def share_approve(token: str, asset_id: uuid.UUID, body: ShareApprove, share_session: Optional[str] = Query(None),
                  db: Session = Depends(get_db), current_user: Optional[User] = Depends(get_optional_user),
                  authorization: Optional[str] = Header(None)):
    """Signed-in staff are recorded as themselves. A guest has no user row, so their approval is recorded for the
    link's creator: the person who made the link `approve` is the one approving through it."""
    from .approvals import _upsert_approval
    _, asset, approver_id = _approvable_asset(db, token, asset_id, share_session, current_user, authorization)
    approver = db.get(User, approver_id)
    versions = db.query(AssetVersion).filter(AssetVersion.asset_id == asset.id, AssetVersion.deleted_at.is_(None))
    version = (versions.filter(AssetVersion.id == body.version_id).first() if body.version_id
               else versions.order_by(AssetVersion.version_number.desc()).first())
    if version is None:
        raise HTTPException(404, "not_found")
    _upsert_approval(db, asset, version.id, approver, ApprovalStatus.approved, None)
    db.add(ActivityLog(user_id=approver_id, asset_id=asset.id, action=ActivityAction.approved))
    db.commit()
    delivery = deliveries.out(deliveries.on_approved(db, asset, version.id, approver))
    return {"asset_id": str(asset.id), "version_id": str(version.id), "status": "approved", "delivery": delivery,
            "parts": deliveries.progress(db, feedback_rounds.request_for_asset(db, asset.id))}


def _round_asset(db: Session, token: str, asset_id: uuid.UUID, share_session, current_user) -> Asset:
    """The asset behind a comment-or-better share link: the gate of every round endpoint here."""
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
    return asset


@router.post("/share/{token}/assets/{asset_id}/feedback-done", status_code=204, dependencies=[Depends(rate_limit("share_feedback_done", 30, 600))])
def share_feedback_done(token: str, asset_id: uuid.UUID, by: Literal["button", "left"] = Query("button"), share_session: Optional[str] = Query(None),
                        db: Session = Depends(get_db), current_user: Optional[User] = Depends(get_optional_user)):
    """The reviewer pressed Send (`by=button`): close the open feedback round now, so the agent starts at once instead of
    after 5 idle minutes. `by=left` is the embed's `pagehide` beacon (navigator.sendBeacon sends no headers or JSON, so the
    reason and the share session ride the query): it closes only a round with a note. No open round / already closed: nothing to do."""
    from datetime import datetime, timezone
    from ..services import feedback_rounds
    asset = _round_asset(db, token, asset_id, share_session, current_user)
    req = feedback_rounds.request_for_asset(db, asset.id)
    if req is not None and by == "left":
        feedback_rounds.close_left(db, req, datetime.now(timezone.utc))
        return Response(status_code=204)
    rnd = feedback_rounds.open_round(db, req.id, lock=True) if req else None
    if rnd is not None:
        try:
            feedback_rounds.close_round(db, rnd, "button", datetime.now(timezone.utc))
        except feedback_rounds.ImagesPending as e:
            raise HTTPException(409, {"error": "images_pending", "comment_ids": e.comment_ids})
    return Response(status_code=204)


@router.post("/share/{token}/assets/{asset_id}/round-sync", dependencies=[Depends(rate_limit("share_round_sync", 120, 600))])
def share_round_sync(token: str, asset_id: uuid.UUID, share_session: Optional[str] = Query(None),
                     db: Session = Depends(get_db), current_user: Optional[User] = Depends(get_optional_user)):
    """The embed asks after a note or an approve: close the round when every module has a note or an approval
    (`closed_by: "all_reviewed"` only on the call that closed it), and say how many notes the open round holds."""
    from datetime import datetime, timezone
    from ..services import feedback_rounds
    asset = _round_asset(db, token, asset_id, share_session, current_user)
    req = feedback_rounds.request_for_asset(db, asset.id)
    closed = feedback_rounds.close_if_all_reviewed(db, req, datetime.now(timezone.utc)) if req else False
    return {"notes": feedback_rounds.notes_count(db, req), "closed_by": "all_reviewed" if closed else None}
