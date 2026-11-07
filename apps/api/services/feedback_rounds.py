"""Feedback rounds: the human comments on one request, handed to the agent that made it.

A round opens with the first human comment in the request folder, stays open while the owner is
active, and closes on the owner's button or after 5 idle minutes. Everything that decides something
(idle, FeedbackV1, rule candidates) is a pure function; the DB code only gathers inputs.
"""
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import settings
from ..models.agent import AgentKey, FeedbackRound
from ..models.asset import Asset, AssetVersion, MediaFile
from ..models.comment import Annotation, Comment, CommentAttachment
from . import comment_attachments as images
from ..models.project import Project
from ..models.upload_request import RequestUpload, UploadRequest
from ..models.user import GuestUser, User

logger = logging.getLogger("apps.api.feedback_rounds")

IDLE_AFTER = timedelta(minutes=5)
SCHEMA = "feedback.v1"


# ── Pure ───────────────────────────────────────────────────────────────────────

def is_idle(last_activity_at: datetime, last_comment_at: Optional[datetime], now: datetime) -> bool:
    last = max(t for t in (last_activity_at, last_comment_at) if t is not None)
    return now - last >= IDLE_AFTER


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value else None


def build_feedback_v1(*, round_id, request_id, project_id, briefing: str, opened_at: datetime, closed_at: datetime,
                      closed_by: str, files: list[dict], context_base: str) -> dict:
    """FeedbackV1 as the contract spells it. `files` carry comments with `t_start` and are ordered here."""
    ordered = sorted(files, key=lambda f: (f["name"].lower(), f["version_number"]))
    return {
        "schema": SCHEMA, "round_id": str(round_id), "request_id": str(request_id), "project_id": str(project_id),
        "briefing": briefing, "opened_at": _iso(opened_at), "closed_at": _iso(closed_at), "closed_by": closed_by,
        "files": [{**{k: f[k] for k in ("asset_id", "version_id", "name", "version_number")},
                   "comments": sorted(f["comments"], key=lambda c: (c["t_start"] is not None, c["t_start"] or 0.0))}
                  for f in ordered],
        "context_url": f"{context_base.rstrip('/')}/api/v1/agents/context?project={project_id}",
    }


def rule_candidates(round_id, comments: list[dict]) -> list[dict]:
    """Every human note is a candidate. `scope` tells the owner's sheet what it is: an untimed note is a
    `standing` preference, a note pinned to a timecode a `scene` instruction (shown after the standing ones).
    Nothing becomes a rule without the owner's accept tap."""
    out = [{"suggestion_id": str(uuid.uuid5(uuid.UUID(str(round_id)), c["comment_id"])), "text": c["text"].strip(),
            "comment_id": c["comment_id"], "scope": "scene" if c["t_start"] is not None else "standing"}
           for c in comments if c["text"].strip()]
    return sorted(out, key=lambda x: x["scope"] != "standing")


# ── Which comments count ───────────────────────────────────────────────────────

def _automation_emails() -> set[str]:
    from ..routers.comments import _automation_guest_emails
    from ..routers.requests import REVIEWER_EMAIL
    return {REVIEWER_EMAIL.lower(), *_automation_guest_emails()}


def human_author(db: Session, comment: Comment) -> Optional[tuple[str, str]]:
    """(name, 'human'|'guest') for a person's comment; None for agents and automation guests."""
    if comment.author_id:
        user = db.get(User, comment.author_id)
        return (user.name, "human") if user and getattr(user, "kind", "human") == "human" else None
    guest = db.get(GuestUser, comment.guest_author_id) if comment.guest_author_id else None
    if guest is None or guest.email.lower() in _automation_emails():
        return None
    return guest.name, "guest"


def request_for_asset(db: Session, asset_id: uuid.UUID) -> Optional[UploadRequest]:
    asset = db.get(Asset, asset_id)
    return db.query(UploadRequest).filter(UploadRequest.folder_id == asset.folder_id).first() if asset and asset.folder_id else None


def open_round(db: Session, request_id: uuid.UUID, *, lock: bool = False) -> Optional[FeedbackRound]:
    q = db.query(FeedbackRound).filter(FeedbackRound.request_id == request_id, FeedbackRound.closed_at.is_(None))
    if lock:
        q = q.populate_existing().with_for_update()
    return q.order_by(FeedbackRound.opened_at.desc()).first()


def on_comment(db: Session, comment_id: uuid.UUID) -> None:
    """After a comment is committed: a person's comment opens a round (or keeps the open one alive).
    Never lets a failure here break posting the comment."""
    try:
        comment = db.get(Comment, comment_id)
        if comment is None or human_author(db, comment) is None:
            return
        req = request_for_asset(db, comment.asset_id)
        if req is None:
            return
        rnd = open_round(db, req.id)
        stamp = comment.created_at or datetime.now(timezone.utc)
        if rnd is None:
            try:
                db.add(FeedbackRound(request_id=req.id, opened_at=stamp, last_activity_at=stamp))
                db.commit()
                return
            except IntegrityError:  # a concurrent comment opened it first: join that round
                db.rollback()
                rnd = open_round(db, req.id)
        if rnd is not None:
            rnd.last_activity_at = max(rnd.last_activity_at, stamp)
        db.commit()
    except Exception:  # noqa: BLE001 - feedback rounds are an extra; the comment is already saved
        db.rollback()
        logger.warning("feedback round bookkeeping failed for comment %s", comment_id, exc_info=True)


def heartbeat(db: Session, request_id: uuid.UUID, now: datetime) -> None:
    rnd = open_round(db, request_id)
    if rnd is not None:
        rnd.last_activity_at = now
        db.commit()


# ── Building and closing ───────────────────────────────────────────────────────

def round_comments(db: Session, rnd: FeedbackRound, req: UploadRequest) -> list[Comment]:
    q = db.query(Comment).join(Asset, Asset.id == Comment.asset_id).filter(
        Asset.folder_id == req.folder_id, Comment.deleted_at.is_(None), Comment.created_at >= rnd.opened_at)
    if rnd.closed_at is not None:
        q = q.filter(Comment.created_at <= rnd.closed_at)
    return [c for c in q.order_by(Comment.created_at).all() if human_author(db, c)]


class ImagesPending(Exception):
    """A round must not close while a comment still waits for its images (spec: never a silent drop)."""
    def __init__(self, comment_ids: list[str]):
        super().__init__("images_pending")
        self.comment_ids = comment_ids


def _uploaded(db: Session, comment_id) -> list[CommentAttachment]:
    return db.query(CommentAttachment).filter(CommentAttachment.comment_id == comment_id,
                                              CommentAttachment.uploaded_at.isnot(None)).order_by(CommentAttachment.created_at).all()


def images_pending(db: Session, comments: list[Comment], now: datetime) -> list[str]:
    """Comments whose announced images are not all in yet - pending or images_failed alike."""
    return [str(c.id) for c in comments if (c.attachments_expected or 0) > 0 and images.comment_state(
        c.attachments_expected, len(_uploaded(db, c.id)), c.created_at, now) != "ready"]


def _ms(seconds: Optional[float]) -> Optional[float]:
    return None if seconds is None else round(seconds, 3)


def _frame_url(db: Session, version_id: uuid.UUID) -> Optional[str]:
    media = db.query(MediaFile).filter(MediaFile.version_id == version_id).first()
    if not media or not media.s3_key_thumbnail:
        return None
    from . import s3_service
    try:
        return s3_service.generate_presigned_get_url(media.s3_key_thumbnail, expires_in=7 * 24 * 3600)
    except Exception:  # noqa: BLE001 - a missing thumbnail must not lose the comment
        return None


def feedback_v1(db: Session, rnd: FeedbackRound) -> dict:
    from . import s3_service
    req = db.get(UploadRequest, rnd.request_id)
    comments = round_comments(db, rnd, req)
    files: dict[tuple, dict] = {}
    for c in comments:
        name, kind = human_author(db, c)
        key = (c.asset_id, c.version_id)
        if key not in files:
            asset, version = db.get(Asset, c.asset_id), db.get(AssetVersion, c.version_id)
            files[key] = {"asset_id": str(c.asset_id), "version_id": str(c.version_id), "name": asset.name,
                          "version_number": version.version_number, "comments": []}
        note = db.query(Annotation).filter(Annotation.comment_id == c.id).first()
        files[key]["comments"].append({
            "comment_id": str(c.id), "t_start": _ms(c.timecode_start), "t_end": _ms(c.timecode_end), "text": c.body,
            "drawing": {"drawing_data": note.drawing_data, "frame_url": _frame_url(db, c.version_id),
                        "mark_offset_ms": note.drawing_data.get("mark_offset_ms") if isinstance(note.drawing_data, dict) else None} if note else None,
            "attachments": [{"attachment_id": str(a.id), "file_name": a.original_filename, "content_type": a.file_type,
                             "url": s3_service.generate_presigned_get_url(a.s3_key, expires_in=7 * 24 * 3600)}
                            for a in _uploaded(db, c.id)],
            "author": name, "author_kind": kind})
    return build_feedback_v1(round_id=rnd.id, request_id=rnd.request_id, project_id=req.project_id, briefing=req.title,
                             opened_at=rnd.opened_at, closed_at=rnd.closed_at, closed_by=rnd.closed_by,
                             files=list(files.values()), context_base=settings.review_bridge_url or "https://review.aditor.ai")


def close_round(db: Session, rnd: FeedbackRound, by: str, now: datetime) -> FeedbackRound:
    if rnd.closed_at is not None:  # never re-close: keeps closed_at, closed_by and accepted flags
        return rnd
    waiting = images_pending(db, round_comments(db, rnd, db.get(UploadRequest, rnd.request_id)), now)
    if waiting:
        raise ImagesPending(waiting)
    rnd.closed_at, rnd.closed_by = now, by
    db.flush()
    req = db.get(UploadRequest, rnd.request_id)
    flat = [{"comment_id": str(c.id), "t_start": c.timecode_start, "text": c.body} for c in round_comments(db, rnd, req)]
    rnd.rule_suggestions = rule_candidates(rnd.id, flat)
    db.commit()
    return rnd


def close_idle(db: Session, now: datetime) -> int:
    closed = 0
    for rnd in db.query(FeedbackRound).filter(FeedbackRound.closed_at.is_(None)).with_for_update(skip_locked=True).all():
        req = db.get(UploadRequest, rnd.request_id)
        last = max((c.created_at for c in round_comments(db, rnd, req)), default=None)
        if is_idle(rnd.last_activity_at, last, now):
            try:
                close_round(db, rnd, "idle", now)
            except ImagesPending:
                continue  # the author still has to retry, remove or send without the image
            closed += 1
    return closed


# ── What the agent may collect ─────────────────────────────────────────────────

def _mine(db: Session, agent_user: User, project_id: uuid.UUID):
    """Rounds of requests in this project that this agent handed versions in to."""
    handed_in = db.query(RequestUpload.request_id).filter(RequestUpload.uploader_email == agent_user.email)
    return db.query(FeedbackRound).join(UploadRequest, UploadRequest.id == FeedbackRound.request_id).filter(
        UploadRequest.project_id == project_id, UploadRequest.id.in_(handed_in))


def agent_rounds(db: Session, agent_user: User, project_id: uuid.UUID, cursor: Optional[datetime]) -> list[FeedbackRound]:
    """Closed, unacknowledged rounds the agent may collect, oldest first."""
    q = _mine(db, agent_user, project_id).filter(FeedbackRound.closed_at.isnot(None), FeedbackRound.acked_at.is_(None))
    if cursor is not None:
        q = q.filter(FeedbackRound.closed_at > cursor)
    return q.order_by(FeedbackRound.closed_at).all()


def agent_round(db: Session, agent_user: User, project_id: uuid.UUID, round_id: uuid.UUID) -> Optional[FeedbackRound]:
    return _mine(db, agent_user, project_id).filter(FeedbackRound.id == round_id).first()


def request_agents(db: Session, request_id: uuid.UUID) -> list[dict]:
    handed_in = db.query(RequestUpload.uploader_email).filter(RequestUpload.request_id == request_id)
    rows = db.query(User, AgentKey).join(AgentKey, AgentKey.user_id == User.id) \
        .filter(User.email.in_(handed_in), User.kind == "agent", AgentKey.revoked_at.is_(None)).all()
    return [{"user_id": str(u.id), "name": u.name, "program": k.program} for u, k in rows]
