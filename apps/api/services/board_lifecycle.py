"""The board manages itself: what is Done, and which agent went quiet. Computed at read time, never stored,
so any new activity (upload, comment, approval) reopens a card with no job and no migration.

Spec: docs/superpowers/specs/2026-11-18-self-managing-board.md
"""
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models.agent import AgentKey
from ..models.approval import Approval, ApprovalStatus
from ..models.asset import AssetVersion
from ..models.comment import Comment
from ..models.user import User

STALE_AFTER = timedelta(days=14)
AGENT_SILENT_AFTER = timedelta(hours=24)
AGENT_LANES = ("editor", "corrections")  # "Agent working" (no upload yet) and "Agent fixing"
PROGRAM_NAMES = {"claude-code": "Claude Code", "gen": "Gen", "codex": "Codex", "chatgpt": "ChatGPT", "cursor": "Cursor",
                 "hermes": "Hermes", "grok": "Grok", "other": "Agent"}


def gen_card_key(external_ref: Optional[str]) -> Optional[str]:
    """`gen:<card key>` is how Gen files a card (one request per ref); anything else has no Desk card."""
    key = external_ref[4:] if external_ref and external_ref.startswith("gen:") else ""
    return key if key and all(c.isalnum() or c in ":_-" for c in key) and len(key) <= 80 else None


def lifecycle(now: datetime, *, last_activity: datetime, last_agent_activity: Optional[datetime], approved: bool,
              delivered: bool, stage: str, is_agent: bool) -> dict:
    """done_reason: delivered | approved | stale | None. stale_agent: an agent-owned card in an agent lane that has
    seen no agent activity for 24 h (and is not Done)."""
    if delivered:
        reason = "delivered"
    elif approved:
        reason = "approved"
    else:
        reason = "stale" if now - last_activity > STALE_AFTER else None
    silent = None
    if reason is None and is_agent and stage in AGENT_LANES and last_agent_activity and now - last_agent_activity > AGENT_SILENT_AFTER:
        silent = last_agent_activity
    return {"done_reason": reason, "stale_agent": silent is not None, "agent_silent_since": silent.isoformat() if silent else None}


def _aware(d: Optional[datetime]) -> Optional[datetime]:
    return d if d is None or d.tzinfo else d.replace(tzinfo=timezone.utc)


def activity(db: Session, reqs: list, assets: dict) -> dict:
    """Per request id: last_activity (any upload, comment, approval, or the request itself), last_agent_activity
    (newest agent upload, else the request's creation) and the worker (agent name + program) of the newest upload.
    `assets` maps request id -> its submitted assets."""
    owner = {a.id: r.id for r in reqs for a in assets.get(r.id, [])}
    ids = list(owner)
    last = {r.id: _aware(r.created_at) or datetime.now(timezone.utc) for r in reqs}
    agent_at = dict(last)
    newest: dict = {}

    def bump(rid, when):
        when = _aware(when)
        if when and when > last[rid]:
            last[rid] = when
    if ids:
        for aid, when, kind, email in db.query(AssetVersion.asset_id, AssetVersion.created_at, User.kind, User.email) \
                .join(User, User.id == AssetVersion.created_by).filter(AssetVersion.asset_id.in_(ids), AssetVersion.deleted_at.is_(None)):
            rid = owner[aid]
            bump(rid, when)
            if kind == "agent" and _aware(when) > agent_at[rid]:
                agent_at[rid] = _aware(when)
            if rid not in newest or _aware(when) > newest[rid][0]:
                newest[rid] = (_aware(when), kind, email)
        for aid, when in db.query(Comment.asset_id, func.max(Comment.created_at)).filter(Comment.asset_id.in_(ids)).group_by(Comment.asset_id):
            bump(owner[aid], when)
        for aid, when in db.query(AssetVersion.asset_id, func.max(Approval.created_at)).join(Approval, Approval.version_id == AssetVersion.id) \
                .filter(AssetVersion.asset_id.in_(ids), Approval.status == ApprovalStatus.approved).group_by(AssetVersion.asset_id):
            bump(owner[aid], when)
    emails = {n[2] for n in newest.values() if n[1] == "agent"}
    programs = {}
    if emails:
        programs = {u.email: (k.agent_name, k.program) for u, k in db.query(User, AgentKey).join(AgentKey, AgentKey.user_id == User.id)
                    .filter(User.email.in_(emails)).order_by(AgentKey.created_at)}
    out = {}
    for r in reqs:
        n = newest.get(r.id)
        if n and n[1] == "agent":
            name, program = programs.get(n[2], (r.last_uploader_name or "Agent", "other"))
            worker = {"name": name, "program": PROGRAM_NAMES.get(program, program), "kind": "agent"}
        elif n:
            worker = {"name": r.last_uploader_name or "Editor", "program": None, "kind": "human"}
        elif gen_card_key(r.external_ref):  # no upload yet: the ref says who filed it
            worker = {"name": "Gen", "program": "Gen", "kind": "agent"}
        else:
            worker = None
        out[r.id] = {"last_activity": last[r.id], "last_agent_activity": agent_at[r.id], "worker": worker,
                     "is_agent": bool(worker and worker["kind"] == "agent") or bool(r.external_ref and not n)}
    return out


def board_fields(now: datetime, req, info: dict, stage: str, approved: bool, delivered: bool) -> dict:
    return {**lifecycle(now, last_activity=info["last_activity"], last_agent_activity=info["last_agent_activity"], approved=approved,
                        delivered=delivered, stage=stage, is_agent=info["is_agent"]),
            "worker": info["worker"], "gen_card_key": gen_card_key(req.external_ref),
            "last_activity_at": info["last_activity"].isoformat()}


def lane_of(state: str, asset_count: int, status: str, phase: Optional[str]) -> str:
    """The web board's `stageOf` (project-kanban.tsx): editor | review | corrections | ready | closed."""
    if state != "live":
        return "closed"
    if phase == "self_review":
        return "review"
    if phase == "agent_stuck":
        return "corrections"
    if not asset_count:
        return "editor"
    if status in ("reviewing", "unavailable"):
        return "review"
    return "corrections" if status == "held" else "ready"


def approved_requests(db: Session, reviews_by_req: dict) -> set:
    """Request ids whose every current version carries an approval (and has at least one)."""
    versions = {rid: [uuid.UUID(a["version_id"]) for a in rs if a.get("version_id")] for rid, rs in reviews_by_req.items()}
    allv = [v for vs in versions.values() for v in vs]
    done = {v for (v,) in db.query(Approval.version_id).filter(Approval.version_id.in_(allv or [uuid.uuid4()]),
            Approval.status == ApprovalStatus.approved, Approval.deleted_at.is_(None))} if allv else set()
    return {rid for rid, vs in versions.items() if vs and all(v in done for v in vs)}
