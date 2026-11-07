"""Feedback rounds, owner side (the player): close, heartbeat, rule suggestions, and who the round goes to."""
import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.agent import FeedbackRound
from ..models.project import Project, ProjectRole
from ..models.upload_request import UploadRequest
from ..models.user import User
from ..services import feedback_rounds as rounds, review_bridge
from ..services.permissions import require_project_role

router = APIRouter(tags=["feedback-rounds"])


def _request(db: Session, request_id: uuid.UUID) -> UploadRequest:
    req = db.query(UploadRequest).filter(UploadRequest.id == request_id).first()
    if not req:
        raise HTTPException(404, "not_found")
    return req


def _owner_of(db: Session, req: UploadRequest, user: User) -> None:
    if req.created_by != user.id:
        require_project_role(db, req.project_id, user, ProjectRole.owner)


class CloseBody(BaseModel):
    reason: Literal["button"] = "button"


@router.post("/requests/{request_id}/feedback-rounds/close")
def close_round(request_id: uuid.UUID, body: CloseBody, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    req = _request(db, request_id)
    _owner_of(db, req, current_user)
    rnd = rounds.open_round(db, req.id, lock=True)
    if rnd is None:
        raise HTTPException(409, "no_open_round")
    try:
        rounds.close_round(db, rnd, "button", datetime.now(timezone.utc))
    except rounds.ImagesPending as e:
        raise HTTPException(409, {"error": "images_pending", "comment_ids": e.comment_ids})
    return rounds.feedback_v1(db, rnd)


@router.post("/requests/{request_id}/heartbeat", status_code=status.HTTP_204_NO_CONTENT)
def heartbeat(request_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    req = _request(db, request_id)
    require_project_role(db, req.project_id, current_user, ProjectRole.viewer)
    rounds.heartbeat(db, req.id, datetime.now(timezone.utc))
    return Response(status_code=204)


@router.get("/requests/{request_id}/agents")
def request_agents(request_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    req = _request(db, request_id)
    require_project_role(db, req.project_id, current_user, ProjectRole.viewer)
    return rounds.request_agents(db, req.id)


def _round(db: Session, round_id: uuid.UUID, user: User) -> tuple[FeedbackRound, UploadRequest]:
    rnd = db.query(FeedbackRound).filter(FeedbackRound.id == round_id).first()
    if not rnd:
        raise HTTPException(404, "not_found")
    req = _request(db, rnd.request_id)
    _owner_of(db, req, user)
    return rnd, req


@router.get("/feedback-rounds/{round_id}/rule-suggestions")
def list_suggestions(round_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    rnd, _ = _round(db, round_id, current_user)
    return [{k: s[k] for k in ("suggestion_id", "text", "comment_id", "scope")} for s in rnd.rule_suggestions if not s.get("accepted")]


@router.post("/feedback-rounds/{round_id}/rule-suggestions/{suggestion_id}/accept", status_code=status.HTTP_204_NO_CONTENT)
def accept_suggestion(round_id: uuid.UUID, suggestion_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Hands the text to the existing rules import of the project's brand; nothing is live until the owner approves it there."""
    from .requests import project_brand
    rnd, req = _round(db, round_id, current_user)
    item = next((s for s in rnd.rule_suggestions if s["suggestion_id"] == suggestion_id), None)
    if item is None:
        raise HTTPException(404, "not_found")
    if not item.get("accepted"):
        project = db.get(Project, req.project_id)
        if review_bridge.import_rules(project_brand(db, project), item["text"]) is None:
            raise HTTPException(503, "review_unavailable")
        rnd.rule_suggestions = [{**s, "accepted": True} if s["suggestion_id"] == suggestion_id else s for s in rnd.rule_suggestions]
        db.commit()
    return Response(status_code=204)
