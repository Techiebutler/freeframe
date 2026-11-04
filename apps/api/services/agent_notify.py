"""Fix loop: the owner hears about an agent's hand-in only when it is clear, or when the agent is stuck.

In-review and corrections versions are the agent's business (it reads them via /agent/assets/{id}/review);
the owner gets ONE event per set of versions: `ready` (every asset clear) or, after 3 agent versions of an
asset that still hold must-fixes, the same event with agent_stuck=true. The event is an ActivityLog row
(action `agent_handin_ready`, actor = the agent) so every surface can read it from one place.
"""
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from ..config import settings
from ..models.activity import ActivityLog
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.upload_request import RequestUpload, UploadRequest
from ..models.user import User

ACTION = "agent_handin_ready"
STUCK_AFTER = 3
SWEEP_WINDOW = timedelta(hours=6)


def decide(assets: list[dict], last_versions: Optional[dict]) -> Optional[dict]:
    """assets: {asset_id, version_number, review_state, agent_versions_since_notice}. None = stay quiet."""
    if not assets:
        return None
    current = {a["asset_id"]: a["version_number"] for a in assets}
    if last_versions == current:
        return None
    if all(a["review_state"] == "clear" for a in assets):
        return {"event": "ready", "agent_stuck": False, "versions": current}
    if any(a["review_state"] == "held" and a["agent_versions_since_notice"] >= STUCK_AFTER for a in assets):
        return {"event": "ready", "agent_stuck": True, "versions": current}
    return None


def _agent_emails(db: Session, request_id: uuid.UUID) -> set[str]:
    emails = {e for (e,) in db.query(RequestUpload.uploader_email).filter(RequestUpload.request_id == request_id).distinct()}
    if not emails:
        return set()
    return {e for (e,) in db.query(User.email).filter(User.email.in_(emails), User.kind == "agent")}


def _last_notice(db: Session, req: UploadRequest) -> Optional[dict]:
    rows = db.query(ActivityLog).filter(ActivityLog.project_id == req.project_id, ActivityLog.action == ACTION) \
        .order_by(ActivityLog.created_at.desc()).limit(50).all()
    return next((r.payload for r in rows if r.payload.get("request_id") == str(req.id)), None)


def evaluate(db: Session, req: UploadRequest, reviews: list[dict]) -> Optional[dict]:
    """`reviews` are the request's per-asset review entries (routers.requests._review_assets). Returns the payload sent, or None."""
    agents = _agent_emails(db, req.id)
    if not agents:
        return None
    last = _last_notice(db, req)
    baseline = (last or {}).get("versions", {})
    assets = []
    for r in reviews:
        since = db.query(RequestUpload).filter(
            RequestUpload.request_id == req.id, RequestUpload.asset_id == uuid.UUID(r["asset_id"]),
            RequestUpload.uploader_email.in_(agents), RequestUpload.version_number > baseline.get(r["asset_id"], 0)).count()
        assets.append({"asset_id": r["asset_id"], "version_number": r["version"], "review_state": r["review_state"],
                       "agent_versions_since_notice": since})
    verdict = decide(assets, (last or {}).get("versions"))
    if verdict is None:
        return None
    payload = {"request_id": str(req.id), "title": req.title, "folder_id": str(req.folder_id), **verdict}
    uploader = db.query(User).filter(User.email.in_(agents)).order_by(User.created_at.desc()).first()
    db.add(ActivityLog(user_id=uploader.id if uploader else None, project_id=req.project_id, action=ACTION, payload=payload))
    db.commit()
    deliver(db, req, payload)
    return payload


def project_owners(db: Session, project_id: uuid.UUID) -> list[User]:
    return db.query(User).join(ProjectMember, ProjectMember.user_id == User.id).filter(
        ProjectMember.project_id == project_id, ProjectMember.role == ProjectRole.owner,
        ProjectMember.deleted_at.is_(None), User.kind == "human").all()


def review_link(project_id, folder_id) -> str:
    return f"{(settings.frontend_url or '').rstrip('/')}/projects/{project_id}/review?folder={folder_id}"


def deliver(db: Session, req: UploadRequest, payload: dict) -> None:
    """Channels beyond the activity row: a Telegram push to every owner who linked a chat (no-op without a bot)."""
    from . import telegram
    stuck = payload["agent_stuck"]
    newer = any(n > 1 for n in payload["versions"].values())
    head = f"{req.title}: the agent is stuck and needs you" if stuck else f"{req.title}: " + ("new version ready" if newer else "ready for your review")
    text = f"{head}\n{review_link(req.project_id, req.folder_id)}"
    for owner in project_owners(db, req.project_id):
        chat = telegram.chat_id_of(owner)
        if chat:
            telegram.send(chat, text)


def sweep(db: Session, now: datetime) -> int:
    """Backstop for agents that stopped polling: look at requests an agent handed into during the last 6 hours."""
    from ..routers.requests import _editor_review
    ids = {rid for (rid,) in db.query(RequestUpload.request_id).filter(RequestUpload.created_at >= now - SWEEP_WINDOW).distinct()}
    sent = 0
    for req in db.query(UploadRequest).filter(UploadRequest.id.in_(ids or {uuid.uuid4()}), UploadRequest.revoked_at.is_(None)).all():
        if not _agent_emails(db, req.id):
            continue
        if evaluate(db, req, _editor_review(db, req)["assets"]):
            sent += 1
    db.commit()
    return sent
