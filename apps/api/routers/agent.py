"""The agent's own API (`Authorization: Bearer ara_...`). An agent sees only its one project; anything else is 404."""
import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_agent
from ..models.activity import ActivityAction, ActivityLog
from ..models.approval import ApprovalStatus
from ..models.asset import Asset, AssetVersion
from ..models.project import Project
from ..models.upload_request import UploadRequest
from ..services import agent_queue, feedback_rounds, review_bridge
from ..services.agents import AgentContext

router = APIRouter(prefix="/agent", tags=["agent"])


def _project(db: Session, agent: AgentContext) -> Project:
    project = db.query(Project).filter(Project.id == agent.key.project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(404, "not_found")
    return project


@router.get("/me")
def me(agent: AgentContext = Depends(get_agent), db: Session = Depends(get_db)):
    project = db.get(Project, agent.key.project_id)
    return {"user_id": str(agent.user.id), "name": agent.user.name, "program": agent.key.program,
            "project_id": str(agent.key.project_id), "project_name": project.name if project else "",
            "brand_slug": (project.autoreview_brand_slug if project else None) or None}


@router.get("/queue")
def queue(state: Optional[Literal["editor", "review", "corrections", "ready"]] = None,
          agent: AgentContext = Depends(get_agent), db: Session = Depends(get_db)):
    items = agent_queue.queue(db, _project(db, agent).id, state)
    if agent.key.scope == "read":  # the upload token is the hand-in right; a read key never sees it
        for item in items:
            item.pop("upload_token", None)
    return items


@router.get("/assets/{asset_id}/review")
def asset_review(asset_id: uuid.UUID, agent: AgentContext = Depends(get_agent), db: Session = Depends(get_db)):
    out = agent_queue.asset_review(db, _project(db, agent).id, asset_id)
    if out is None:
        raise HTTPException(404, "not_found")
    return out


@router.post("/assets/{asset_id}/approve")
def approve(asset_id: uuid.UUID, agent: AgentContext = Depends(get_agent), db: Session = Depends(get_db)):
    from .approvals import _upsert_approval
    project = _project(db, agent)
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.project_id == project.id, Asset.deleted_at.is_(None)).first()
    if asset is None:
        raise HTTPException(404, "not_found")
    if not project.agents_may_approve:
        raise HTTPException(403, "agents_may_not_approve")
    version = db.query(AssetVersion).filter(AssetVersion.asset_id == asset.id, AssetVersion.deleted_at.is_(None)) \
        .order_by(AssetVersion.version_number.desc()).first()
    if version is None:
        raise HTTPException(404, "not_found")
    _upsert_approval(db, asset, version.id, agent.user, ApprovalStatus.approved, None)
    db.add(ActivityLog(user_id=agent.user.id, asset_id=asset.id, action=ActivityAction.approved))
    db.commit()
    return {"asset_id": str(asset.id), "version_id": str(version.id), "status": "approved"}


class RuleSuggestion(BaseModel):
    text: str = Field(min_length=3, max_length=2000)
    evidence: str = Field(default="", max_length=2000)


@router.post("/rules/suggestion")
def suggest_rule(body: RuleSuggestion, agent: AgentContext = Depends(get_agent), db: Session = Depends(get_db)):
    """Lands in the owner's pending-suggestions inbox via the rules import; never a live rule."""
    from .requests import project_brand
    brand = project_brand(db, _project(db, agent))
    text = body.text.strip() + (f"\n\nEvidence: {body.evidence.strip()}" if body.evidence.strip() else "")
    if review_bridge.import_rules(brand, text) is None:
        raise HTTPException(503, "review_unavailable")
    return {"suggestion_id": str(uuid.uuid4())}


@router.get("/feedback")
def feedback(cursor: str = "", agent: AgentContext = Depends(get_agent), db: Session = Depends(get_db)):
    """Closed, unacknowledged rounds after `cursor` (an ISO timestamp, or empty), oldest first."""
    try:
        after = datetime.fromisoformat(cursor) if cursor else None
    except ValueError:
        raise HTTPException(422, "invalid_cursor")
    if after is not None and after.tzinfo is None:
        after = after.replace(tzinfo=timezone.utc)
    rows = feedback_rounds.agent_rounds(db, agent.user, _project(db, agent).id, after)
    return {"rounds": [feedback_rounds.feedback_v1(db, r) for r in rows],
            "next_cursor": rows[-1].closed_at.isoformat() if rows else (cursor or None)}


@router.post("/feedback/{round_id}/ack", status_code=status.HTTP_204_NO_CONTENT)
def ack(round_id: uuid.UUID, agent: AgentContext = Depends(get_agent), db: Session = Depends(get_db)):
    rnd = feedback_rounds.agent_round(db, agent.user, _project(db, agent).id, round_id)
    if rnd is None:
        raise HTTPException(404, "not_found")
    if rnd.acked_at is None:
        rnd.acked_at = datetime.now(timezone.utc)
        db.commit()
    return Response(status_code=204)


class NewRequest(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    external_ref: str = Field(min_length=1, max_length=200)


def _request_reply(req: UploadRequest, created: bool) -> dict:
    return {"request_id": str(req.id), "folder_id": str(req.folder_id), "upload_token": req.token, "review_url": agent_queue.review_url(req), "created": created}


@router.post("/requests")
def create_request(body: NewRequest, agent: AgentContext = Depends(get_agent), db: Session = Depends(get_db)):
    """File a card for self-review: a normal request (folder, standing review link, AutoReview registration)
    owned by the agent. The same (project, external_ref) always answers with the same request."""
    from .requests import RequestCreate, create_request as create_normal_request
    project = _project(db, agent)
    ref = body.external_ref.strip()
    found = lambda: db.query(UploadRequest).filter(UploadRequest.project_id == project.id, UploadRequest.external_ref == ref).first()  # noqa: E731
    existing = found()
    if existing:
        return _request_reply(existing, False)
    # The binding behind a normal request is idempotent on this key, so a retry after a crash finds the same request.
    made = create_normal_request(RequestCreate(project_id=project.id, title=body.title.strip(),
                                               idempotency_key=uuid.uuid5(project.id, f"agent-request:{ref}")), db, agent.user)
    req = db.get(UploadRequest, uuid.UUID(made["id"]))
    try:
        req.external_ref = ref
        db.commit()
    except IntegrityError:  # a concurrent call attached the ref first
        db.rollback()
        return _request_reply(found(), False)
    return _request_reply(req, True)
