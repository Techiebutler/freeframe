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
from ..models.approval import Approval, ApprovalStatus
from ..models.agent import AgentKey, FeedbackRound
from ..models.asset import Asset, AssetVersion, MediaFile
from ..models.comment import Annotation, Comment, CommentAttachment, CommentDictation
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
                      closed_by: str, files: list[dict], context_base: str, dictations: Optional[list[dict]] = None) -> dict:
    """FeedbackV1 as the contract spells it. `files` carry comments with `t_start` and are ordered here.
    `dictations` (round level, additive) is present only when the round has spoken notes."""
    ordered = sorted(files, key=lambda f: (f["name"].lower(), f["version_number"]))
    out = {
        "schema": SCHEMA, "round_id": str(round_id), "request_id": str(request_id), "project_id": str(project_id),
        "briefing": briefing, "opened_at": _iso(opened_at), "closed_at": _iso(closed_at), "closed_by": closed_by,
        "files": [{**{k: f[k] for k in ("asset_id", "version_id", "name", "version_number")},
                   "comments": sorted(f["comments"], key=lambda c: (c["t_start"] is not None, c["t_start"] or 0.0))}
                  for f in ordered],
        "context_url": f"{context_base.rstrip('/')}/api/v1/agents/context?project={project_id}",
    }
    if dictations:
        out["dictations"] = dictations
    return out


PAUSE_S = 1.5  # dictation-sentences.ts PAUSE_S: a longer pause ends a sentence
INK_FRAME_TOL = 0.25
FRAME_TIMEOUT = timedelta(seconds=60)


def mark_id(index: int) -> str:
    """Server-derived, stable because a comment's marks are stored once."""
    return f"m{index}"


def with_mark_ids(drawing_data):
    """drawing_data as stored plus `mark_id` on every mark (a copy; the stored JSON is untouched)."""
    if not (isinstance(drawing_data, dict) and isinstance(drawing_data.get("marks"), list)):
        return drawing_data
    return {**drawing_data, "marks": [{**m, "mark_id": mark_id(i)} if isinstance(m, dict) else m for i, m in enumerate(drawing_data["marks"])]}


def _sentences_from_words(words: list[dict]) -> list[dict]:
    out: list[dict] = []
    cur: list[dict] = []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        if w["w"].rstrip("\"')").endswith((".", "?", "!", "…")) or (nxt and nxt["start_s"] - w["end_s"] > PAUSE_S):
            out.append({"text": " ".join(x["w"] for x in cur), "start_s": cur[0]["start_s"], "end_s": cur[-1]["end_s"]})
            cur = []
    if cur:
        out.append({"text": " ".join(x["w"] for x in cur), "start_s": cur[0]["start_s"], "end_s": cur[-1]["end_s"]})
    return out


def segments_for(words: list[dict], marks: list[dict], segments: Optional[list[dict]] = None) -> list[dict]:
    """Which strokes were drawn while each segment was spoken. Both on the recording clock: a mark's stroke starts at
    `offset_ms / 1000`; it belongs to the last segment that had started by then (the first, when it began earlier) -
    the same rule as flow-notes.ts, made explicit. `segments` as stored with the dictation (they carry `video_t`);
    without them the sentences are cut from `words` (backfill). Returns the segments with `mark_ids`."""
    segs = [dict(s) for s in (segments if segments is not None else _sentences_from_words(words))]
    for s in segs:
        s["mark_ids"] = []
    if not segs:
        return segs
    for i, m in enumerate(marks):
        if not isinstance(m, dict):
            continue
        at = (m.get("offset_ms") or 0) / 1000
        k = 0
        for j, s in enumerate(segs):
            if s["start_s"] <= at:
                k = j
        segs[k]["mark_ids"].append(mark_id(i))
    return segs


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
    """Comments whose announced images (or dictation audio) are not all in yet - pending or images_failed alike - and
    drawn comments whose PNG is still being rendered (frame_state 'pending': at most FRAME_TIMEOUT, then the round goes on)."""
    out = []
    for c in comments:
        got = [a for a in _uploaded(db, c.id) if a.kind != "frame_png"]  # the worker's PNGs were never announced
        if (c.attachments_expected or 0) > 0 and images.comment_state(c.attachments_expected, len(got), c.created_at, now) != "ready":
            out.append(str(c.id))
        elif frame_state(db, c, now) == "pending":
            out.append(str(c.id))
    return out


def _ms(seconds: Optional[float]) -> Optional[float]:
    return None if seconds is None else round(seconds, 3)


# The client uploads the frame with the ink rendered on it as a normal comment image with this file name.
# Legacy / fallback only: the server renders `frame_png` attachments now (kind column).
DRAWN_FRAME_NAME = "drawn-frame"


def _is_drawn_frame(a: CommentAttachment) -> bool:
    return (a.original_filename or "").lower().startswith(DRAWN_FRAME_NAME)


def _is_client_frame(a: CommentAttachment) -> bool:
    return a.kind != "frame_png" and _is_drawn_frame(a)


def _has_marks(drawing_data) -> bool:
    return isinstance(drawing_data, dict) and any(isinstance(m, dict) and m.get("points") for m in drawing_data.get("marks") or [])


def frame_state(db: Session, comment: Comment, now: datetime) -> str:
    """'ready' (a server frame_png exists) | 'pending' (render due, under FRAME_TIMEOUT old) | 'failed' (render failed or
    timed out; the client picture or thumbnail stands in) | 'unavailable' (no marks, or no media to render from) | 'none' (no drawing)."""
    note = db.query(Annotation).filter(Annotation.comment_id == comment.id).first()
    if note is None:
        return "none"
    if not _has_marks(note.drawing_data):
        return "unavailable"
    if db.query(CommentAttachment.id).filter(CommentAttachment.comment_id == comment.id, CommentAttachment.kind == "frame_png",
                                             CommentAttachment.uploaded_at.isnot(None)).first():
        return "ready"
    if comment.frame_status == "failed":
        return "failed"
    from . import drawn_frame
    if not drawn_frame.has_renderable_media(db, comment.version_id):
        return "unavailable"
    created = comment.created_at if comment.created_at.tzinfo else comment.created_at.replace(tzinfo=timezone.utc)
    return "pending" if now - created < FRAME_TIMEOUT else "failed"


def _url(key: str) -> str:
    from . import s3_service
    return s3_service.generate_presigned_get_url(key, expires_in=7 * 24 * 3600)


def _thumbnail_url(db: Session, version_id: uuid.UUID) -> Optional[str]:
    media = db.query(MediaFile).filter(MediaFile.version_id == version_id).first()
    if not media or not media.s3_key_thumbnail:
        return None
    try:
        return _url(media.s3_key_thumbnail)
    except Exception:  # noqa: BLE001 - a missing thumbnail must not lose the comment
        return None


def _frame(db: Session, comment: Comment, atts: list[CommentAttachment], now: datetime) -> tuple[Optional[str], Optional[str], str]:
    """(frame_url, frame_source, frame_status): the server PNG, else the client's drawn-frame picture, else the thumbnail (older rounds)."""
    state = frame_state(db, comment, now)
    server = sorted((a for a in atts if a.kind == "frame_png"), key=lambda a: a.t or 0.0)
    for a, source in [(server[0], "server")] if server else []:
        try:
            return _url(a.s3_key), source, state
        except Exception:  # noqa: BLE001
            pass
    client = next((a for a in atts if _is_client_frame(a)), None)
    if client:
        try:
            return _url(client.s3_key), "client", state
        except Exception:  # noqa: BLE001
            pass
    thumb = _thumbnail_url(db, comment.version_id)
    return thumb, ("thumbnail" if thumb else None), state


def _drawing(note: Annotation, frame_url, frame_source, frame_status, *, extended: bool) -> dict:
    """`drawing` as it always was (drawing_data, frame_url, mark_offset_ms). Once the comment has something that refers to
    its strokes - a server frame, a client frame, or a dictation - the strokes are named (`mark_id`) and the frame is labelled."""
    dd = note.drawing_data
    out = {"drawing_data": with_mark_ids(dd) if extended else dd, "frame_url": frame_url,
           "mark_offset_ms": dd.get("mark_offset_ms") if isinstance(dd, dict) else None}
    if extended:
        out.update(frame_source=frame_source, frame_status=frame_status)
    return out


def _attachment_json(a: CommentAttachment, version_id: uuid.UUID) -> dict:
    meta = a.meta or {}
    out = {"attachment_id": str(a.id), "kind": a.kind or "reference_image", "file_name": a.original_filename,
           "content_type": a.file_type, "url": _url(a.s3_key), "version_id": str(a.version_id or version_id), "t": a.t}
    if a.kind == "frame_png":
        out.update(mark_ids=meta.get("mark_ids", []), width=meta.get("width"), height=meta.get("height"))
        if meta.get("source") and meta["source"] != "raw":
            out["source"] = meta["source"]  # rendered from a proxy, not the raw master: same frame, lower resolution
    if a.kind == "dictation_audio":
        out["duration_s"] = meta.get("duration_s")
    return out


def _words_json(d: CommentDictation) -> list[dict]:
    return [{"w": w["w"], "start_s": w["start_s"], "end_s": w["end_s"]} for w in d.words or []]


def feedback_v1(db: Session, rnd: FeedbackRound) -> dict:
    req = db.get(UploadRequest, rnd.request_id)
    comments = round_comments(db, rnd, req)
    now = datetime.now(timezone.utc)
    files: dict[tuple, dict] = {}
    spoken: dict[uuid.UUID, dict] = {}  # dictation_id -> {row, comments: [(comment, marks)]}
    for c in comments:
        name, kind = human_author(db, c)
        key = (c.asset_id, c.version_id)
        if key not in files:
            asset, version = db.get(Asset, c.asset_id), db.get(AssetVersion, c.version_id)
            files[key] = {"asset_id": str(c.asset_id), "version_id": str(c.version_id), "name": asset.name,
                          "version_number": version.version_number, "comments": []}
        note = db.query(Annotation).filter(Annotation.comment_id == c.id).first()
        atts = _uploaded(db, c.id)
        marks = [m for m in (note.drawing_data.get("marks") or [])] if note and isinstance(note.drawing_data, dict) else []
        dictation = db.get(CommentDictation, c.dictation_id) if c.dictation_id else None
        own = []
        if dictation is not None:
            all_segs = segments_for(_words_json(dictation), marks, list(dictation.segments or []))
            own = [{k: s.get(k) for k in ("text", "start_s", "end_s", "video_t", "mark_ids")} for s in all_segs if s.get("segment_index") == c.segment_index]
            spoken.setdefault(dictation.id, {"row": dictation, "comments": []})["comments"].append((c, all_segs))
        frame_url, frame_source, frame_status = _frame(db, c, atts, now)
        files[key]["comments"].append({
            "comment_id": str(c.id), "t_start": _ms(c.timecode_start), "t_end": _ms(c.timecode_end), "text": c.body,
            "dictation_id": str(c.dictation_id) if c.dictation_id else None,
            "segment_index": c.segment_index if c.dictation_id else None,
            "segments": own,
            "drawing": _drawing(note, frame_url, frame_source, frame_status, extended=bool(c.dictation_id) or frame_status in ("ready", "pending", "failed") or frame_source in ("server", "client")) if note else None,
            "attachments": [_attachment_json(a, c.version_id) for a in atts if not _is_client_frame(a)],
            "author": name, "author_kind": kind})
    dictations = []
    for did, g in spoken.items():
        d = g["row"]
        owners = {c.segment_index: (c, segs) for c, segs in g["comments"]}  # sentence -> the comment it became + that comment's mark assignment
        segs = []
        for i, s in enumerate(d.segments or []):
            owner, mine = owners.get(s.get("segment_index"), (None, []))
            segs.append({"text": s.get("text"), "start_s": s.get("start_s"), "end_s": s.get("end_s"), "video_t": s.get("video_t"),
                         "mark_ids": mine[i]["mark_ids"] if mine else [], "comment_id": str(owner.id) if owner else None})
        ordered = sorted(g["comments"], key=lambda x: x[0].segment_index or 0)
        dictations.append({"dictation_id": str(did), "comment_ids": [str(c.id) for c, _ in ordered],
                           "text": d.text, **({"raw_text": d.raw_text} if d.raw_text else {}), "lang": d.lang,
                           "audio_attachment_id": str(d.audio_attachment_id) if d.audio_attachment_id else None,
                           "clock": "recording_s", "words": _words_json(d), "segments": segs})
    return build_feedback_v1(round_id=rnd.id, request_id=rnd.request_id, project_id=req.project_id, briefing=req.title,
                             opened_at=rnd.opened_at, closed_at=rnd.closed_at, closed_by=rnd.closed_by,
                             files=list(files.values()), context_base=settings.review_bridge_url or "https://review.aditor.ai",
                             dictations=dictations)


def close_round(db: Session, rnd: FeedbackRound, by: str, now: datetime) -> FeedbackRound:
    if rnd.closed_at is not None:  # never re-close: keeps closed_at, closed_by and accepted flags
        return rnd
    waiting = images_pending(db, round_comments(db, rnd, db.get(UploadRequest, rnd.request_id)), now)
    if waiting:
        raise ImagesPending(waiting)
    req = db.get(UploadRequest, rnd.request_id)
    void_approvals_commented_after(db, round_comments(db, rnd, req))  # before the agent can see the round
    rnd.closed_at, rnd.closed_by = now, by
    db.flush()
    flat = [{"comment_id": str(c.id), "t_start": c.timecode_start, "text": c.body} for c in round_comments(db, rnd, req)]
    rnd.rule_suggestions = rule_candidates(rnd.id, flat)
    db.commit()
    return rnd


def void_approvals_commented_after(db: Session, comments: list[Comment]) -> None:
    """A closed round of human comments on a version that was approved earlier takes that approval back (the same
    undo as a person's: unsent deliveries go, a link already handed on stays). Comments older than the approval
    do not count: approving after commenting is the person saying the comments are settled."""
    try:
        from ..routers.approvals import remove_approval
        newest: dict[tuple, datetime] = {}
        for c in comments:
            key = (c.asset_id, c.version_id)
            newest[key] = max(newest.get(key, c.created_at), c.created_at)
        for (asset_id, version_id), commented_at in newest.items():
            asset = db.get(Asset, asset_id)
            held = db.query(Approval).filter(Approval.version_id == version_id, Approval.status == ApprovalStatus.approved,
                                             Approval.deleted_at.is_(None), Approval.created_at < commented_at).all()
            for user_id in {a.user_id for a in held}:
                remove_approval(db, asset, user_id, version_id)
    except Exception:  # noqa: BLE001 - the round is closed either way; the lock then simply asks for reopen=true
        db.rollback()
        logger.warning("voiding approvals after round close failed", exc_info=True)


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


# ── Embed: leaving and "every module reviewed" ─────────────────────────────────

def notes_count(db: Session, req: Optional[UploadRequest]) -> int:
    """Human comments in the open round (0 when none is open): what the embed tells Gen as `notes`."""
    rnd = open_round(db, req.id) if req else None
    return len(round_comments(db, rnd, req)) if rnd else 0


def close_left(db: Session, req: UploadRequest, now: datetime) -> bool:
    """The embed went away (tile folded, card switched): a round with at least one note closes as `left`, so the
    agent starts. No open round, no note, or a note still waiting for its image: nothing happens (never a silent drop)."""
    rnd = open_round(db, req.id, lock=True)
    if rnd is None or not round_comments(db, rnd, req):
        return False
    try:
        close_round(db, rnd, "left", now)
    except ImagesPending:
        return False
    return True


def all_reviewed(db: Session, rnd: FeedbackRound, req: UploadRequest) -> bool:
    """Every part (deliveries.request_parts) has a comment in this round or is approved, and the round has a comment.
    Never for a single part: its first note would close the round while the reviewer is still typing (Send or leaving closes it)."""
    from . import deliveries
    commented = {c.asset_id for c in round_comments(db, rnd, req)}
    parts = deliveries.request_parts(db, req)
    return bool(commented) and len(parts) >= 2 and all(approved or a_id in commented for a_id, _v, approved in parts)


def close_if_all_reviewed(db: Session, req: UploadRequest, now: datetime) -> bool:
    rnd = open_round(db, req.id, lock=True)
    if rnd is None or not all_reviewed(db, rnd, req):
        db.rollback()
        return False
    try:
        close_round(db, rnd, "all_reviewed", now)
    except ImagesPending:
        return False
    return True


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


# ── Retention: reviewer voice notes ────────────────────────────────────────────

AUDIO_RETENTION = timedelta(days=90)


def purge_dictation_audio(db: Session, now: datetime) -> int:
    """Delete dictation audio 90 days after the round it belongs to was acknowledged (the words stay; only the voice goes).
    A round nobody acknowledged keeps its audio. Returns how many recordings were removed."""
    from . import s3_service
    cutoff = now - AUDIO_RETENTION
    rows = (db.query(CommentAttachment, Comment)
            .join(Comment, Comment.id == CommentAttachment.comment_id)
            .join(Asset, Asset.id == Comment.asset_id)
            .join(UploadRequest, UploadRequest.folder_id == Asset.folder_id)
            .join(FeedbackRound, FeedbackRound.request_id == UploadRequest.id)
            .filter(CommentAttachment.kind == "dictation_audio", FeedbackRound.acked_at.isnot(None), FeedbackRound.acked_at < cutoff,
                    Comment.created_at >= FeedbackRound.opened_at, FeedbackRound.closed_at.isnot(None), Comment.created_at <= FeedbackRound.closed_at)
            .all())
    removed = 0
    for att, comment in rows:
        try:
            s3_service.delete_object(att.s3_key)
        except Exception:  # noqa: BLE001 - the row goes anyway; an orphan object is swept by sweep_orphan_s3
            logger.warning("could not delete dictation audio object %s", att.s3_key, exc_info=True)
        if comment.dictation_id:
            d = db.get(CommentDictation, comment.dictation_id)
            if d is not None and d.audio_attachment_id == att.id:
                d.audio_attachment_id = None
        db.delete(att)
        removed += 1
    db.commit()
    return removed
