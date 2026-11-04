"""What an agent works from: its project's live requests by kanban stage, and one asset's review."""
import uuid
from typing import Optional

from sqlalchemy.orm import Session

from ..config import settings
from ..models.approval import Approval, ApprovalStatus
from ..models.asset import Asset
from ..models.project import Project
from ..models.upload_request import UploadRequest
from ..models.user import GuestUser
from . import agent_notify, review_bridge
from .review_phase import phase_of_reviews

STAGES = ("editor", "review", "corrections", "ready")


def stage_of(state: str, asset_count: int, gate_status: str) -> str:
    """The web board's `stageOf` (project-kanban.tsx), word for word."""
    if state != "live":
        return "closed"
    if not asset_count:
        return "editor"
    if gate_status in ("reviewing", "unavailable"):
        return "review"
    return "corrections" if gate_status == "held" else "ready"


def review_url(req: UploadRequest) -> Optional[str]:
    """The request's standing review share link on the web app (what the owner opens), None without one."""
    return f"{(settings.frontend_url or '').rstrip('/')}/share/{req.review_share_token}" if req.review_share_token else None


def queue(db: Session, project_id: uuid.UUID, state: Optional[str] = None) -> list[dict]:
    from ..routers import requests as r
    from datetime import datetime, timezone
    reqs = db.query(UploadRequest).filter(UploadRequest.project_id == project_id).order_by(UploadRequest.created_at.desc()).limit(100).all()
    reqs = [q for q in reqs if r.request_state(q, datetime.now(timezone.utc)) == "live"]
    statuses = review_bridge.request_status([q.review_share_token for q in reqs])
    assets = {q.id: r._submitted_assets(db, q) for q in reqs}
    stats = review_bridge.asset_stats([str(a.id) for items in assets.values() for a in items])
    reviewer = db.query(GuestUser).filter(GuestUser.email == r.REVIEWER_EMAIL).first()
    out = []
    for q in reqs:
        reviews = r._review_assets(db, q, assets[q.id], reviewer, stats, include_media=False)
        approved = {str(v) for (v,) in db.query(Approval.version_id).filter(
            Approval.version_id.in_([uuid.UUID(a["version_id"]) for a in reviews if a.get("version_id")]),
            Approval.status == ApprovalStatus.approved, Approval.deleted_at.is_(None))}
        gate = r._request_gate(reviews, statuses.get(q.review_share_token))
        agent_notify.evaluate(db, q, reviews)
        stage = stage_of("live", len(assets[q.id]), gate["status"])
        if state and stage != state:
            continue
        out.append({"request_id": str(q.id), "title": q.title, "folder_id": str(q.folder_id), "stage": stage,
                    "upload_token": q.token, "review_url": review_url(q), "review_phase": phase_of_reviews(db, reviews),
                    "assets": [{"asset_id": a["asset_id"], "name": a["name"], "version_id": a["version_id"],
                                "version_number": a["version"], "review_state": a["review_state"],
                                "processing_status": a["processing"],
                                "approval": "approved" if a["version_id"] in approved else None} for a in reviews]})
    db.commit()  # _review_assets records observed campaign usage
    return out


def split_notes(comments: list[dict]) -> tuple[list[dict], list[dict]]:
    def note(c):
        src = c.get("review_source") or {}
        sources = src.get("sources") or []
        return {"t": c.get("t"), "rule": src.get("requirement_id") or (sources[0]["reference_id"] if sources else ""), "text": c["body"]}
    return [note(c) for c in comments if c.get("must_fix")], [note(c) for c in comments if not c.get("must_fix")]


def asset_review(db: Session, project_id: uuid.UUID, asset_id: uuid.UUID) -> Optional[dict]:
    """None when the asset is not in a request of THIS project (the caller answers 404)."""
    from ..routers import requests as r
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.project_id == project_id, Asset.deleted_at.is_(None)).first()
    req = db.query(UploadRequest).filter(UploadRequest.folder_id == asset.folder_id, UploadRequest.project_id == project_id).first() if asset else None
    if req is None:
        return None
    entry = next((a for a in r._editor_review(db, req)["assets"] if a["asset_id"] == str(asset.id)), None)
    db.commit()
    if entry is None:
        return None
    must_fix, guidance = split_notes(entry["comments"])
    return {"asset_id": entry["asset_id"], "version_id": entry["version_id"], "review_state": entry["review_state"],
            "gate": {"status": entry["review_state"], "open_must_fixes": entry["open_must_fixes"]},
            "must_fix": must_fix, "guidance": guidance}
