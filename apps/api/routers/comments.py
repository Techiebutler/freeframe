import hmac
import logging
import hashlib
import hmac
import json
import re
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy import text, and_, or_
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..middleware.auth import get_current_user, get_optional_user
from ..middleware.share_auth import get_share_link
from ..models.asset import Asset, AssetType, AssetVersion, MediaFile, ProcessingStatus
from ..models.project import ProjectMember, ProjectRole
from ..models.comment import Annotation, Comment, CommentAttachment, CommentReaction
from ..models.activity import Mention, Notification, NotificationType, ActivityLog, ActivityAction
from ..models.user import User, GuestUser
from ..models.share import ShareLink, ShareLinkActivity, ShareActivityAction, SharePermission
from ..schemas.comment import (
    AnnotationResponse,
    AttachmentResponse,
    AttachmentUploadRequest,
    AttachmentUploadResponse,
    AuthorInfo,
    GuestAuthorInfo,
    CommentCreate,
    CommentResponse,
    CommentUpdate,
    GuestCommentCreate,
    ReactionCreate,
    ReactionResponse,
    ReviewCommentCreate,
    public_review_source,
)
from ..services import brand_loop, feedback_rounds, s3_service
from ..services import comment_export
from ..services.permissions import (
    require_asset_access, can_access_asset, validate_share_link_with_session, validate_asset_in_share,
)
from ..tasks.email_tasks import send_mention_email, send_comment_email
from ..tasks.celery_app import send_task_safe

log = logging.getLogger(__name__)

router = APIRouter(tags=["comments"])

EXPORT_FORMATS = {
    "edl": ("text/plain; charset=utf-8", "edl"),
    "fcpxml": ("application/xml", "fcpxml"),
    "premiere_xml": ("application/xml", "xml"),
    "csv": ("text/csv; charset=utf-8", "csv"),
}
_START_TC_RE = re.compile(r"^\d{2}[:;]\d{2}[:;]\d{2}[:;]\d{2}$")


# ── Helpers ────────────────────────────────────────────────────────────────────

def _get_asset(db: Session, asset_id: uuid.UUID) -> Asset:
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


def _get_comment(db: Session, comment_id: uuid.UUID) -> Comment:
    comment = db.query(Comment).filter(Comment.id == comment_id, Comment.deleted_at.is_(None)).first()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    return comment


def _build_attachment_response(attachment: CommentAttachment) -> AttachmentResponse:
    url = s3_service.generate_presigned_get_url(attachment.s3_key, expires_in=3600)
    return AttachmentResponse(
        id=attachment.id,
        file_name=attachment.original_filename,
        file_size=attachment.file_size_bytes,
        content_type=attachment.file_type,
        url=url,
    )


def _build_reaction_responses(
    reactions: list[CommentReaction],
    current_user_id: uuid.UUID | None,
) -> list[ReactionResponse]:
    counts: dict[str, int] = defaultdict(int)
    reacted: dict[str, bool] = defaultdict(bool)
    for r in reactions:
        counts[r.emoji] += 1
        if current_user_id and r.user_id == current_user_id:
            reacted[r.emoji] = True
    return [
        ReactionResponse(emoji=emoji, count=cnt, reacted=reacted[emoji])
        for emoji, cnt in counts.items()
    ]


def _build_comment_response(
    comment: Comment,
    db: Session,
    current_user_id: uuid.UUID | None = None,
    depth: int = 5,
) -> CommentResponse:
    annotation = db.query(Annotation).filter(Annotation.comment_id == comment.id).first()
    replies_raw = []
    if depth > 0:
        replies_raw = db.query(Comment).filter(
            Comment.parent_id == comment.id,
            Comment.deleted_at.is_(None),
        ).order_by(Comment.created_at).all()

    # Load attachments
    attachments_raw = db.query(CommentAttachment).filter(
        CommentAttachment.comment_id == comment.id,
    ).all()
    attachments = [_build_attachment_response(a) for a in attachments_raw]

    # Load reactions
    reactions_raw = db.query(CommentReaction).filter(
        CommentReaction.comment_id == comment.id,
    ).all()
    reactions = _build_reaction_responses(reactions_raw, current_user_id)

    # Load author info
    author_info = None
    if comment.author_id:
        author = db.query(User).filter(User.id == comment.author_id).first()
        if author:
            author_info = AuthorInfo(id=author.id, name=author.name, avatar_url=author.avatar_url)

    guest_author_info = None
    if comment.guest_author_id:
        guest = db.query(GuestUser).filter(GuestUser.id == comment.guest_author_id).first()
        if guest:
            guest_author_info = GuestAuthorInfo(id=guest.id, name=guest.name, email=guest.email)

    resp = CommentResponse.model_validate(comment)
    resp.author = author_info
    resp.guest_author = guest_author_info
    resp.annotation = AnnotationResponse.model_validate(annotation) if annotation else None
    resp.replies = [
        _build_comment_response(r, db, current_user_id=current_user_id, depth=depth - 1)
        for r in replies_raw
    ]
    resp.attachments = attachments
    resp.reactions = reactions
    return resp


def _get_annotations_map(comment_ids: list[uuid.UUID], db: Session) -> dict:
    """Batch-load annotations for a list of comment IDs."""
    if not comment_ids:
        return {}
    annotations = db.query(Annotation).filter(Annotation.comment_id.in_(comment_ids)).all()
    return {a.comment_id: a for a in annotations}


def _build_comment_responses_batched(
    asset_id: uuid.UUID,
    top_level: list[Comment],
    db: Session,
    current_user_id: uuid.UUID | None = None,
    max_depth: int = 5,
    exclude_internal: bool = False,
) -> list[CommentResponse]:
    """Build the comment tree for `top_level` with a FIXED number of queries
    instead of one-per-comment. Field-for-field equivalent to calling
    _build_comment_response on each top-level comment, but ~6 queries total
    regardless of how many comments the asset has (avoids the N+1 that made the
    list endpoint slow — and it's re-fetched after every comment save).

    exclude_internal drops visibility="internal" comments (and their whole subtree, since a
    reply to a team-only comment is team-only too) — set for guest/public callers so an
    internal note never reaches a share link, no matter how deep in the thread it is."""
    if not top_level:
        return []

    # One query for every non-deleted comment on the asset → parent→children map.
    all_comments_query = db.query(Comment).filter(
        Comment.asset_id == asset_id, Comment.deleted_at.is_(None),
    )
    if exclude_internal:
        all_comments_query = all_comments_query.filter(Comment.visibility != "internal")
    all_comments = all_comments_query.order_by(Comment.created_at).all()
    children_map: dict[uuid.UUID, list[Comment]] = defaultdict(list)
    for c in all_comments:
        if c.parent_id is not None:
            children_map[c.parent_id].append(c)

    # Walk the subtree we will actually render (top-level + descendants to
    # max_depth) to collect the ids whose related rows we must load.
    included: list[Comment] = []

    def _collect(comment: Comment, depth: int) -> None:
        included.append(comment)
        if depth > 0:
            for child in children_map.get(comment.id, []):
                _collect(child, depth - 1)

    for c in top_level:
        _collect(c, max_depth)
    ids = [c.id for c in included]

    # Batch-load related rows keyed by comment_id (one query each).
    annotations = {
        a.comment_id: a
        for a in db.query(Annotation).filter(Annotation.comment_id.in_(ids)).all()
    }
    attachments_map: dict[uuid.UUID, list[CommentAttachment]] = defaultdict(list)
    for a in db.query(CommentAttachment).filter(CommentAttachment.comment_id.in_(ids)).all():
        attachments_map[a.comment_id].append(a)
    reactions_map: dict[uuid.UUID, list[CommentReaction]] = defaultdict(list)
    for r in db.query(CommentReaction).filter(CommentReaction.comment_id.in_(ids)).all():
        reactions_map[r.comment_id].append(r)

    author_ids = {c.author_id for c in included if c.author_id}
    authors = (
        {u.id: u for u in db.query(User).filter(User.id.in_(author_ids)).all()}
        if author_ids else {}
    )
    guest_ids = {c.guest_author_id for c in included if c.guest_author_id}
    guests = (
        {g.id: g for g in db.query(GuestUser).filter(GuestUser.id.in_(guest_ids)).all()}
        if guest_ids else {}
    )

    def _build(comment: Comment, depth: int) -> CommentResponse:
        resp = CommentResponse.model_validate(comment)
        author = authors.get(comment.author_id) if comment.author_id else None
        resp.author = (
            AuthorInfo(id=author.id, name=author.name, avatar_url=author.avatar_url)
            if author else None
        )
        guest = guests.get(comment.guest_author_id) if comment.guest_author_id else None
        resp.guest_author = (
            GuestAuthorInfo(id=guest.id, name=guest.name, email=guest.email)
            if guest else None
        )
        ann = annotations.get(comment.id)
        resp.annotation = AnnotationResponse.model_validate(ann) if ann else None
        resp.attachments = [
            _build_attachment_response(a) for a in attachments_map.get(comment.id, [])
        ]
        resp.reactions = _build_reaction_responses(
            reactions_map.get(comment.id, []), current_user_id
        )
        resp.replies = (
            [_build(child, depth - 1) for child in children_map.get(comment.id, [])]
            if depth > 0 else []
        )
        return resp

    return [_build(c, max_depth) for c in top_level]


def _parse_mentions(body: str) -> list[str]:
    """Extract @email mentions from comment body."""
    return re.findall(r"@([\w.+-]+@[\w.-]+\.\w+)", body)


def _create_mentions(db: Session, comment: Comment, asset: Asset, body: str, author_name: str, mention_user_ids: list | None = None) -> None:
    """Create Mention + Notification records and send emails.
    Uses explicit mention_user_ids if provided, else falls back to parsing @email from body."""
    from ..services.auth_service import get_user_by_email
    from ..config import settings

    mentioned_users = []

    if mention_user_ids:
        # Use explicit user IDs from frontend
        for uid in set(mention_user_ids):
            user = db.query(User).filter(User.id == uid).first()
            if user and user.id != comment.author_id:
                mentioned_users.append(user)
    else:
        # Fallback: parse @email from body
        emails = _parse_mentions(body)
        for email in set(emails):
            user = get_user_by_email(db, email)
            if user and user.id != comment.author_id:
                mentioned_users.append(user)

    # A mention must only reach someone who can actually see the asset — otherwise any user
    # (or a guest via a share link) could @mention an arbitrary user id/email and have their
    # name, the asset name, and a comment preview emailed to someone with no access to either.
    mentioned_users = [u for u in mentioned_users if can_access_asset(db, asset, u)]

    for user in mentioned_users:
        mention = Mention(comment_id=comment.id, mentioned_user_id=user.id)
        db.add(mention)
        notif = Notification(
            user_id=user.id,
            type=NotificationType.mention,
            asset_id=asset.id,
            comment_id=comment.id,
        )
        db.add(notif)

        asset_link = f"{settings.frontend_url}/projects/{asset.project_id}/assets/{asset.id}"
        send_task_safe(send_mention_email,
            to_email=user.email,
            mentioner_name=author_name,
            asset_name=asset.name,
            comment_preview=body[:200],
            asset_link=asset_link,
        )


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.get("/assets/{asset_id}/comments", response_model=list[CommentResponse])
def list_comments(
    asset_id: uuid.UUID,
    version_id: Optional[uuid.UUID] = None,
    visibility: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = _get_asset(db, asset_id)
    require_asset_access(db, asset, current_user)
    # Top-level comments only (parent_id is None)
    query = db.query(Comment).filter(
        Comment.asset_id == asset_id,
        Comment.parent_id.is_(None),
        Comment.deleted_at.is_(None),
    )
    if version_id:
        query = query.filter(Comment.version_id == version_id)
    if visibility and visibility in ("public", "internal"):
        query = query.filter(Comment.visibility == visibility)
    top_level = query.order_by(Comment.created_at).all()
    return _build_comment_responses_batched(asset_id, top_level, db, current_user_id=current_user.id)


@router.post("/assets/{asset_id}/comments", response_model=CommentResponse, status_code=status.HTTP_201_CREATED)
def create_comment(
    asset_id: uuid.UUID,
    body: CommentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    background_tasks: BackgroundTasks = None,
):
    asset = _get_asset(db, asset_id)
    require_asset_access(db, asset, current_user)

    version = db.query(AssetVersion).filter(
        AssetVersion.id == body.version_id, AssetVersion.asset_id == asset_id,
        AssetVersion.deleted_at.is_(None),
    ).first()
    if not version:
        raise HTTPException(status_code=400, detail="version_id does not belong to this asset")

    comment = Comment(
        asset_id=asset_id,
        version_id=body.version_id,
        parent_id=body.parent_id,
        author_id=current_user.id,
        timecode_start=body.timecode_start,
        timecode_end=body.timecode_end,
        body=body.body,
        visibility=body.visibility or "public",
    )
    db.add(comment)
    db.flush()

    if body.annotation:
        annotation = Annotation(
            comment_id=comment.id,
            drawing_data=body.annotation.drawing_data,
            frame_number=body.annotation.frame_number,
            carousel_position=body.annotation.carousel_position,
        )
        db.add(annotation)

    _create_mentions(db, comment, asset, body.body, current_user.name, body.mention_user_ids)

    # Notify asset creator about the comment (unless they're the commenter)
    if asset.created_by and asset.created_by != current_user.id:
        db.add(Notification(
            user_id=asset.created_by,
            type=NotificationType.comment,
            asset_id=asset_id,
            comment_id=comment.id,
        ))

    # Activity log
    activity = ActivityLog(user_id=current_user.id, asset_id=asset_id, action=ActivityAction.commented)
    db.add(activity)

    db.commit()
    db.refresh(comment)
    feedback_rounds.on_comment(db, comment.id)
    brand_loop.queue_comment(background_tasks, db, comment, asset, author_email=current_user.email)
    # A logged-in client (non-staff account) commenting in the app routes to the responsible editor,
    # same as an anonymous share-link comment. announce_client_comment no-ops for team members.
    from ..services import hub_events
    hub_events.announce_client_comment(db, comment, asset, current_user.name)
    return _build_comment_response(comment, db, current_user_id=current_user.id)


@router.post("/assets/{asset_id}/comments/{comment_id}/replies", response_model=CommentResponse, status_code=status.HTTP_201_CREATED)
def reply_to_comment(
    asset_id: uuid.UUID,
    comment_id: uuid.UUID,
    body: CommentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    background_tasks: BackgroundTasks = None,
):
    asset = _get_asset(db, asset_id)
    require_asset_access(db, asset, current_user)
    parent = db.query(Comment).filter(
        Comment.id == comment_id, Comment.asset_id == asset_id, Comment.deleted_at.is_(None),
    ).first()
    if not parent:
        raise HTTPException(status_code=404, detail="Parent comment not found")

    # Force body's version_id to match parent
    reply = Comment(
        asset_id=asset_id,
        version_id=parent.version_id,
        parent_id=comment_id,
        author_id=current_user.id,
        body=body.body,
    )
    db.add(reply)
    db.flush()
    _create_mentions(db, reply, asset, body.body, current_user.name, body.mention_user_ids)

    # Notify parent comment author about the reply (unless they're the replier)
    if parent.author_id and parent.author_id != current_user.id:
        db.add(Notification(
            user_id=parent.author_id,
            type=NotificationType.comment,
            asset_id=asset_id,
            comment_id=reply.id,
        ))

    db.commit()
    db.refresh(reply)
    feedback_rounds.on_comment(db, reply.id)
    brand_loop.queue_comment(background_tasks, db, reply, asset, author_email=current_user.email)
    # A logged-in client's reply is still client feedback - route it to the editor too.
    from ..services import hub_events
    hub_events.announce_client_comment(db, reply, asset, current_user.name)
    return _build_comment_response(reply, db, current_user_id=current_user.id)


@router.patch("/comments/{comment_id}", response_model=CommentResponse)
def update_comment(
    comment_id: uuid.UUID,
    body: CommentUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    comment = db.query(Comment).filter(Comment.id == comment_id, Comment.deleted_at.is_(None)).first()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    # Allow comment owner or project owner to edit
    if comment.author_id != current_user.id:
        asset = _get_asset(db, comment.asset_id)
        member = db.query(ProjectMember).filter(
            ProjectMember.project_id == asset.project_id,
            ProjectMember.user_id == current_user.id,
            ProjectMember.role == ProjectRole.owner,
            ProjectMember.deleted_at.is_(None),
        ).first()
        if not member:
            raise HTTPException(status_code=403, detail="Can only edit your own comments")
    if comment.body != body.body:
        comment.review_source = None
    comment.body = body.body
    comment.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(comment)
    return _build_comment_response(comment, db, current_user_id=current_user.id)


@router.delete("/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_comment(
    comment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    comment = db.query(Comment).filter(Comment.id == comment_id, Comment.deleted_at.is_(None)).first()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    # Allow comment owner or project owner to delete
    if comment.author_id != current_user.id:
        asset = _get_asset(db, comment.asset_id)
        member = db.query(ProjectMember).filter(
            ProjectMember.project_id == asset.project_id,
            ProjectMember.user_id == current_user.id,
            ProjectMember.role == ProjectRole.owner,
            ProjectMember.deleted_at.is_(None),
        ).first()
        if not member:
            raise HTTPException(status_code=403, detail="Can only delete your own comments")
    comment.deleted_at = datetime.now(timezone.utc)
    db.commit()


@router.post("/comments/{comment_id}/resolve", response_model=CommentResponse)
def resolve_comment(
    comment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    comment = db.query(Comment).filter(Comment.id == comment_id, Comment.deleted_at.is_(None)).first()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    asset = _get_asset(db, comment.asset_id)
    require_asset_access(db, asset, current_user)
    comment.resolved = not comment.resolved
    db.commit()
    db.refresh(comment)
    return _build_comment_response(comment, db, current_user_id=current_user.id)


# ── Attachments ────────────────────────────────────────────────────────────────

@router.post(
    "/comments/{comment_id}/attachments",
    response_model=AttachmentUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_attachment(
    comment_id: uuid.UUID,
    body: AttachmentUploadRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    comment = _get_comment(db, comment_id)
    asset = _get_asset(db, comment.asset_id)
    require_asset_access(db, asset, current_user)

    # Generate S3 key
    key = f"comment-attachments/{comment_id}/{uuid.uuid4()}/{body.file_name}"

    # Generate presigned PUT URL
    s3 = s3_service.get_s3_client()
    upload_url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.s3_bucket,
            "Key": key,
            "ContentType": body.content_type,
        },
        ExpiresIn=3600,
    )

    # Save attachment record
    attachment = CommentAttachment(
        comment_id=comment_id,
        file_type=body.content_type,
        s3_key=key,
        original_filename=body.file_name,
        file_size_bytes=body.file_size,
    )
    db.add(attachment)
    db.commit()
    db.refresh(attachment)

    return AttachmentUploadResponse(
        upload_url=upload_url,
        attachment_id=attachment.id,
        key=key,
    )


@router.delete(
    "/comments/{comment_id}/attachments/{attachment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_attachment(
    comment_id: uuid.UUID,
    attachment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    comment = _get_comment(db, comment_id)
    asset = _get_asset(db, comment.asset_id)

    attachment = db.query(CommentAttachment).filter(
        CommentAttachment.id == attachment_id,
        CommentAttachment.comment_id == comment_id,
    ).first()
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Must be comment author OR project owner/editor
    from ..models.project import ProjectRole
    from ..services.permissions import effective_project_role
    is_comment_author = comment.author_id == current_user.id
    if not is_comment_author:
        role = effective_project_role(db, asset.project_id, current_user)
        if role not in (ProjectRole.owner, ProjectRole.editor):
            raise HTTPException(status_code=403, detail="Not authorized to delete this attachment")

    # Delete from S3
    try:
        s3_service.delete_object(attachment.s3_key)
    except Exception:
        pass  # Best-effort S3 deletion

    db.delete(attachment)
    db.commit()


# ── Reactions ──────────────────────────────────────────────────────────────────

@router.post("/comments/{comment_id}/react", status_code=status.HTTP_204_NO_CONTENT)
def toggle_reaction(
    comment_id: uuid.UUID,
    body: ReactionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    comment = _get_comment(db, comment_id)
    asset = _get_asset(db, comment.asset_id)
    require_asset_access(db, asset, current_user)

    existing = db.query(CommentReaction).filter(
        CommentReaction.comment_id == comment_id,
        CommentReaction.user_id == current_user.id,
        CommentReaction.emoji == body.emoji,
    ).first()

    if existing:
        db.delete(existing)
    else:
        reaction = CommentReaction(
            comment_id=comment_id,
            user_id=current_user.id,
            emoji=body.emoji,
        )
        db.add(reaction)

    db.commit()


@router.get("/comments/{comment_id}/reactions", response_model=list[ReactionResponse])
def list_reactions(
    comment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    comment = _get_comment(db, comment_id)
    asset = _get_asset(db, comment.asset_id)
    require_asset_access(db, asset, current_user)

    reactions_raw = db.query(CommentReaction).filter(
        CommentReaction.comment_id == comment_id,
    ).all()
    return _build_reaction_responses(reactions_raw, current_user.id)


# ── Deep link ──────────────────────────────────────────────────────────────────

@router.get("/assets/{asset_id}/comments/{comment_id}/link")
def comment_deep_link(
    asset_id: uuid.UUID,
    comment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = _get_asset(db, asset_id)
    require_asset_access(db, asset, current_user)
    # Verify comment belongs to this asset
    comment = db.query(Comment).filter(
        Comment.id == comment_id,
        Comment.asset_id == asset_id,
        Comment.deleted_at.is_(None),
    ).first()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    url = f"{settings.frontend_url}/assets/{asset_id}?comment={comment_id}"
    return {"url": url}


@router.get("/assets/{asset_id}/comments/export")
def export_comments(
    asset_id: uuid.UUID,
    format: str = Query(...),
    version_id: Optional[uuid.UUID] = Query(default=None),
    fps: Optional[float] = Query(default=None, gt=0),
    start_tc: str = Query(default="01:00:00:00"),
    include_resolved: bool = Query(default=True),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Export a version's comments as NLE timeline markers (#84):
    Resolve marker EDL, FCPXML (Final Cut), FCP7 XML (Premiere), or CSV."""
    if format not in EXPORT_FORMATS:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported format '{format}'. Use one of: {', '.join(EXPORT_FORMATS)}",
        )

    asset = _get_asset(db, asset_id)
    require_asset_access(db, asset, current_user)

    if version_id is not None:
        version = db.query(AssetVersion).filter(
            AssetVersion.id == version_id,
            AssetVersion.asset_id == asset.id,
            AssetVersion.deleted_at.is_(None),
        ).first()
    else:
        version = db.query(AssetVersion).filter(
            AssetVersion.asset_id == asset.id,
            AssetVersion.processing_status == ProcessingStatus.ready,
            AssetVersion.deleted_at.is_(None),
        ).order_by(AssetVersion.version_number.desc()).first()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")

    spec = None
    if format == "csv":
        media_file = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
        stored_fps = media_file.fps if media_file else None
        if fps or stored_fps:
            spec = comment_export.snap_fps(fps or stored_fps)  # None is fine for CSV
    else:
        if asset.asset_type != AssetType.video:
            raise HTTPException(
                status_code=422,
                detail="EDL/FCPXML/Premiere XML export is only available for video assets; use format=csv",
            )
        media_file = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
        effective_fps = fps or (media_file.fps if media_file else None)
        if not effective_fps:
            raise HTTPException(status_code=422, detail={
                "code": "fps_required",
                "message": "Frame rate unknown for this version; pass ?fps= "
                           "(e.g. 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60)",
            })
        spec = comment_export.snap_fps(effective_fps)
        if spec is None:
            raise HTTPException(
                status_code=422,
                detail=f"Unsupported frame rate {effective_fps}; supported: "
                       + ", ".join(str(round(s.fps, 3)) for s in comment_export.FPS_TABLE),
            )
        if format == "edl":
            if not _START_TC_RE.match(start_tc):
                raise HTTPException(status_code=422, detail="start_tc must be HH:MM:SS:FF")
            hh, mm, ss, ff = (int(p) for p in re.split(r"[:;]", start_tc))
            if not (hh <= 23 and mm < 60 and ss < 60 and ff < spec.timebase):
                raise HTTPException(status_code=422, detail="start_tc out of range for the frame rate")

    comments = db.query(Comment).filter(
        Comment.version_id == version.id,
        Comment.deleted_at.is_(None),
    ).order_by(Comment.created_at.asc()).all()

    user_ids = {c.author_id for c in comments if c.author_id}
    guest_ids = {c.guest_author_id for c in comments if c.guest_author_id}
    users = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    guests = {g.id: g for g in db.query(GuestUser).filter(GuestUser.id.in_(guest_ids)).all()} if guest_ids else {}

    rows = []
    for c in comments:
        author = users.get(c.author_id) or guests.get(c.guest_author_id)
        rows.append(comment_export.CommentRow(
            id=str(c.id),
            parent_id=str(c.parent_id) if c.parent_id else None,
            author_name=(author.name or author.email) if author else "Unknown",
            author_email=author.email if author else "",
            body=c.body,
            timecode_start=c.timecode_start,
            timecode_end=c.timecode_end,
            resolved=bool(c.resolved),
            created_at=c.created_at,
            version_number=version.version_number,
            review_source=public_review_source(getattr(c, "review_source", None)),
        ))

    duration_frames = 0
    if spec is not None and media_file is not None and media_file.duration_seconds:
        duration_frames = comment_export.seconds_to_frames(media_file.duration_seconds, spec)

    if format == "csv":
        if not include_resolved:
            rows = [r for r in rows if not r.resolved]
        content = "\ufeff" + comment_export.to_csv(rows, spec)  # BOM for Excel
    else:
        markers = comment_export.build_markers(rows, spec, include_resolved)
        if format == "edl":
            if len(markers) > comment_export.EDL_MAX_EVENTS:
                log.warning(
                    "EDL export for asset %s truncated: %d markers exceed EDL_MAX_EVENTS=%d, "
                    "%d dropped",
                    asset_id, len(markers), comment_export.EDL_MAX_EVENTS,
                    len(markers) - comment_export.EDL_MAX_EVENTS,
                )
            content = comment_export.to_edl(
                markers, spec, comment_export.tc_to_frames(start_tc, spec), asset.name)
        elif format == "fcpxml":
            content = comment_export.to_fcpxml(markers, spec, asset.name, duration_frames)
        else:
            content = comment_export.to_premiere_xml(markers, spec, asset.name, duration_frames)

    media_type, ext = EXPORT_FORMATS[format]
    safe_name = re.sub(r"[^\w\-. ]", "_", asset.name, flags=re.ASCII).strip() or "asset"
    filename = f"{safe_name}_v{version.version_number}_comments.{ext}"
    utf8_name = quote(f"{asset.name}_v{version.version_number}_comments.{ext}", safe="")
    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Content-Disposition": (
                f'attachment; filename="{filename}"; filename*=UTF-8\'\'{utf8_name}'
            )
        },
    )


# ── Guest comments (via share link) ───────────────────────────────────────────

def _require_review_bridge(authorization: Optional[str] = Header(default=None)) -> None:
    secret = settings.review_bridge_secret.strip()
    if not secret:
        raise HTTPException(status_code=503, detail="Review bridge is not configured")
    expected = f"Bearer {secret}".encode()
    if not hmac.compare_digest((authorization or "").encode(), expected):
        raise HTTPException(status_code=401, detail="Invalid review bridge credentials")


@router.post("/review-bridge/share/{token}/comments", response_model=CommentResponse,
             status_code=status.HTTP_201_CREATED, dependencies=[Depends(_require_review_bridge)])
def publish_review_comment(
    token: str,
    body: ReviewCommentCreate,
    share_session: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """Bridge-only publication. Email selects an allowed identity AFTER service authentication.

    The caller binds H1 sources before model planning. The API validates scope and a stable
    publication identity; it never derives provenance from a name, email or comment text.
    """
    if body.guest_email not in _automation_guest_emails():
        raise HTTPException(status_code=403, detail="Automation identity is not enabled")
    link = validate_share_link_with_session(db, token, share_session=share_session)
    if link.permission == SharePermission.view:
        raise HTTPException(status_code=403, detail="This share link does not allow commenting")
    asset = _get_asset(db, body.asset_id)
    validate_asset_in_share(db, link, asset)
    # Serializes simultaneous retries on this version. No latest-version guessing.
    version = db.query(AssetVersion).filter(
        AssetVersion.id == body.version_id, AssetVersion.asset_id == asset.id,
        AssetVersion.deleted_at.is_(None),
        or_(AssetVersion.processing_status == ProcessingStatus.ready,
            and_(AssetVersion.processing_status == ProcessingStatus.processing,
                 AssetVersion.iteration_review_ready.is_(True))),
    ).with_for_update().first()
    if not version:
        raise HTTPException(status_code=404, detail="Ready version not found for this asset")

    digest = hashlib.sha256(json.dumps(body.model_dump(mode="json"), sort_keys=True,
                                       separators=(",", ":")).encode()).hexdigest()
    # Include deleted rows to prevent a retry from resurrecting removed feedback.
    existing = db.query(Comment).filter(Comment.review_publication_id == body.publication_id).first()
    if existing:
        if existing.asset_id != asset.id or existing.version_id != version.id or existing.review_publication_sha256 != digest:
            raise HTTPException(status_code=409, detail="Publication ID already used for a different payload")
        if existing.deleted_at is not None:
            raise HTTPException(status_code=409, detail="Publication was deleted")
        return _build_comment_response(existing, db)

    guest = db.query(GuestUser).filter(GuestUser.email == body.guest_email).first()
    if not guest:
        # Different reviewed versions can publish this identity for the first time together.
        db.execute(insert(GuestUser).values(id=uuid.uuid4(), email=body.guest_email, name="Auto Review")
                   .on_conflict_do_nothing(index_elements=["email"]))
        guest = db.query(GuestUser).filter(GuestUser.email == body.guest_email).first()
    comment = Comment(
        asset_id=asset.id, version_id=version.id, guest_author_id=guest.id,
        body=body.body, timecode_start=body.timecode_start, timecode_end=body.timecode_end,
        visibility="internal", review_source=body.review_source.model_dump(exclude_none=True) if body.review_source else None,
        review_publication_id=body.publication_id, review_publication_sha256=digest,
    )
    db.add(comment)
    try:
        db.flush()
        db.add(ShareLinkActivity(share_link_id=link.id, action=ShareActivityAction.commented,
                                actor_email=guest.email, actor_name=guest.name,
                                asset_id=asset.id, asset_name=asset.name))
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Publication identity conflict")
    db.refresh(comment)
    return _build_comment_response(comment, db)

@router.get("/share/{token}/comments")
def list_share_comments(
    token: str,
    asset_id: Optional[uuid.UUID] = None,
    version_id: Optional[uuid.UUID] = None,
    latest_only: bool = False,
    share_session: Optional[str] = Query(None, alias="share_session"),
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_user),
):
    """Public endpoint — list comments for a shared asset. Enforces the share link's password
    (if any) via share_session, same as the other public share endpoints.
    For folder/project shares, pass asset_id as query param to get comments for a specific asset —
    it's validated against the link's scope, so it can't be used to read another asset's comments.
    Pass version_id to scope comments to a single version (matches the authenticated review view).
    Pass latest_only=true to scope to the latest ready version — used by the folder/grid preview,
    which has no version picker."""
    link = validate_share_link_with_session(db, token, share_session=share_session, current_user=current_user)

    # Determine the asset_id to list comments for
    target_asset_id = link.asset_id or asset_id
    if not target_asset_id:
        return []
    asset = _get_asset(db, target_asset_id)
    validate_asset_in_share(db, link, asset)
    asset_id = asset.id

    # The folder/grid preview has no version switcher, so it scopes to the latest ready version.
    if latest_only and not version_id:
        from ..models.asset import AssetVersion, ProcessingStatus
        latest = db.query(AssetVersion).filter(
            AssetVersion.asset_id == asset_id,
            AssetVersion.deleted_at.is_(None),
            AssetVersion.processing_status == ProcessingStatus.ready,
        ).order_by(AssetVersion.version_number.desc()).first()
        version_id = latest.id if latest else version_id

    # Get top-level comments — reuse same format as authenticated endpoint. Internal-visibility
    # comments are team-only and must never reach a public share link.
    query = db.query(Comment).filter(
        Comment.asset_id == asset_id,
        Comment.parent_id.is_(None),
        Comment.deleted_at.is_(None),
        Comment.visibility != "internal",
    )
    if version_id:
        query = query.filter(Comment.version_id == version_id)
    top_level = query.order_by(Comment.created_at).all()

    # Batched build (fixed query count) — guests have no user, so no current_user_id.
    # The automated reviewer's comments are stored visibility="internal" (see guest_comment), so the
    # exclude_internal filter above already keeps them off this client-facing timeline.
    return _build_comment_responses_batched(asset_id, top_level, db, exclude_internal=True)


def automation_comment_id(token, asset_id, version_id, key, authorization):
    secret = settings.review_bridge_secret
    if not secret or not hmac.compare_digest(authorization or '', f'Bearer {secret}'):
        raise HTTPException(403, 'Only the connected reviewer may use a comment idempotency key.')
    return uuid.uuid5(uuid.NAMESPACE_URL, f'freeframe-review:{token}:{asset_id}:{version_id}:{key}')


def validate_comment_version(db, asset_id, version_id):
    version = db.query(AssetVersion).filter(AssetVersion.id == version_id, AssetVersion.asset_id == asset_id,
        AssetVersion.deleted_at.is_(None)).first()
    if not version or (version.processing_status != ProcessingStatus.ready and not (version.processing_status == ProcessingStatus.processing and getattr(version,'iteration_review_ready',False) is True)):
        raise HTTPException(409, 'This video version is unavailable. Refresh the review.')
    return version


@router.post("/share/{token}/comment", response_model=CommentResponse, status_code=status.HTTP_201_CREATED)
def guest_comment(
    token: str,
    body: GuestCommentCreate,
    share_session: Optional[str] = Query(None, alias="share_session"),
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_user),
    authorization: Optional[str] = Header(default=None),
    background_tasks: BackgroundTasks = None,
):
    link = validate_share_link_with_session(db, token, share_session=share_session, current_user=current_user)

    # Check share link permission allows commenting
    if link.permission == SharePermission.view:
        raise HTTPException(status_code=403, detail="This share link does not allow commenting")

    # Resolve asset_id: from the link when it's scoped to one asset; otherwise from the request
    # body (folder/project shares only), validated against the link's actual scope below — the
    # link's own asset_id always wins so a single-asset link can't be redirected to another asset.
    target_asset_id = link.asset_id or body.asset_id
    if not target_asset_id:
        raise HTTPException(status_code=400, detail="asset_id is required for folder/project shares")
    asset = _get_asset(db, target_asset_id)
    validate_asset_in_share(db, link, asset)

    # Resolve version_id: use provided or get latest ready version
    version_id = body.version_id
    if not version_id:
        from ..models.asset import AssetVersion, ProcessingStatus
        latest = db.query(AssetVersion).filter(
            AssetVersion.asset_id == asset.id,
            AssetVersion.deleted_at.is_(None),
            AssetVersion.processing_status == ProcessingStatus.ready,
        ).order_by(AssetVersion.version_number.desc()).first()
        if latest:
            version_id = latest.id
        else:
            raise HTTPException(status_code=400, detail="No ready version found for this asset")

    if not current_user and (not body.guest_email or not body.guest_name):
        raise HTTPException(400,'guest_email and guest_name required for anonymous comments')
    if body.version_id:
        validate_comment_version(db, asset.id, version_id)
    comment_id = None
    if body.idempotency_key:
        comment_id = automation_comment_id(token, asset.id, version_id, body.idempotency_key, authorization)
        # Serialize retries even across processes; the unique comment ID is the durable backstop.
        lock_key = int.from_bytes(comment_id.bytes[:8], 'big', signed=True)
        db.execute(text('SELECT pg_advisory_xact_lock(:key)'), {'key': lock_key})
        prior = db.query(Comment).filter(Comment.id == comment_id).first()
        if prior:
            return _build_comment_response(prior, db)

    # Determine author: logged-in user or guest
    author_id = None
    guest_author_id = None
    if current_user:
        author_id = current_user.id
    else:
        if not body.guest_email or not body.guest_name:
            raise HTTPException(status_code=400, detail="guest_email and guest_name required for anonymous comments")
        guest_email = body.guest_email.lower()
        guest = db.query(GuestUser).filter(GuestUser.email == guest_email).first()
        if not guest:
            guest = GuestUser(email=guest_email, name=body.guest_name)
            db.add(guest)
            db.flush()
        guest_author_id = guest.id

    # A comment from a configured automation guest (the craft reviewer) is stored internal, so the
    # existing exclude-internal share filter keeps it off every client-facing timeline while members
    # still see it in the app. Human guests and members are never affected.
    visibility = _guest_comment_visibility(guest_author_id, body.guest_email)

    comment = Comment(
        asset_id=asset.id,
        version_id=version_id,
        parent_id=body.parent_id,
        author_id=author_id,
        guest_author_id=guest_author_id,
        timecode_start=body.timecode_start,
        timecode_end=body.timecode_end,
        body=body.body,
        visibility=visibility,
    )
    if comment_id:
        comment.id = comment_id
    db.add(comment)
    db.flush()

    # Parse mentions (guest can mention registered users)
    emails = _parse_mentions(body.body)
    for email in set(emails):
        from ..services.auth_service import get_user_by_email
        user = get_user_by_email(db, email)
        if user:
            mention = Mention(comment_id=comment.id, mentioned_user_id=user.id)
            db.add(mention)
            notif = Notification(
                user_id=user.id,
                type=NotificationType.mention,
                asset_id=asset.id,
                comment_id=comment.id,
            )
            db.add(notif)

    if body.annotation:
        annotation = Annotation(
            comment_id=comment.id,
            drawing_data=body.annotation.drawing_data,
            frame_number=body.annotation.frame_number,
            carousel_position=body.annotation.carousel_position,
        )
        db.add(annotation)

    db.commit()
    db.refresh(comment)

    # Log share link activity
    actor_email = current_user.email if current_user else (body.guest_email or "anonymous")
    actor_name = current_user.name if current_user else body.guest_name
    activity = ShareLinkActivity(
        share_link_id=link.id,
        action=ShareActivityAction.commented,
        actor_email=actor_email,
        actor_name=actor_name,
        asset_id=asset.id,
        asset_name=asset.name,
    )
    db.add(activity)
    db.commit()

    feedback_rounds.on_comment(db, comment.id)
    brand_loop.queue_comment(background_tasks, db, comment, asset, share_token=token,
                             author_email=current_user.email if current_user else guest_email)
    from ..services import hub_events
    hub_events.announce_client_comment(db, comment, asset, actor_name)

    return _build_comment_response(comment, db)


def _deletable_guest_emails() -> set[str]:
    """The guest identities allowed to remove their own share comments. Empty = the feature is off."""
    raw = getattr(settings, "share_comment_deletable_guest_emails", "") or ""
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def _automation_guest_emails() -> set[str]:
    """Guest identities that are automation, not people (the craft reviewer). Empty = none.
    Their comments are stored internal so the existing share filter keeps them off client views."""
    raw = getattr(settings, "automation_guest_emails", "") or ""
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def _guest_comment_visibility(guest_author_id, guest_email: Optional[str]) -> str:
    """Visibility to store a new share comment with: 'internal' for a configured automation guest
    (the craft reviewer - kept off client-facing shares by the existing filter, still shown to
    members in the app), 'public' for every human guest and every member."""
    if guest_author_id is not None and (guest_email or "").lower() in _automation_guest_emails():
        return "internal"
    return "public"


@router.delete("/share/{token}/comment/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_guest_comment(
    token: str,
    comment_id: uuid.UUID,
    guest_email: str = Query(..., description="the guest identity that wrote the comment"),
    share_session: Optional[str] = Query(None, alias="share_session"),
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_user),
):
    """Let a configured automation delete a comment it wrote itself, through the share link.

    A guest commenter has no account, so today it can never take back a comment: a superseded or
    plainly wrong automated note sits on a client-facing timeline until a project owner removes it
    by hand. This closes that, and nothing else.

    Four conditions, all required:
      * the share link is valid and allows commenting (a view-only link stays read-only);
      * the comment is on an asset actually inside that share;
      * the comment was written by a GUEST, never by a person with an account;
      * that guest's email is one of settings.share_comment_deletable_guest_emails.

    The list is empty by default, so an instance that does not configure it behaves exactly as it
    does today. Deletion is the same soft delete the owner path uses - the row is retained.
    """
    allowed = _deletable_guest_emails()
    if not allowed:
        raise HTTPException(status_code=403, detail="Deleting share comments is not enabled on this instance")
    if guest_email.strip().lower() not in allowed:
        raise HTTPException(status_code=403, detail="This guest identity may not delete comments")

    link = validate_share_link_with_session(db, token, share_session=share_session, current_user=current_user)
    if link.permission == SharePermission.view:
        raise HTTPException(status_code=403, detail="This share link does not allow commenting")

    comment = db.query(Comment).filter(Comment.id == comment_id, Comment.deleted_at.is_(None)).first()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    # A comment with an author_id belongs to a PERSON. Never reachable here, whatever the config.
    if comment.author_id is not None or comment.guest_author_id is None:
        raise HTTPException(status_code=403, detail="Only a guest's own comments can be deleted this way")

    guest = db.query(GuestUser).filter(GuestUser.id == comment.guest_author_id).first()
    if not guest or (guest.email or "").lower() != guest_email.strip().lower():
        raise HTTPException(status_code=403, detail="This comment was written by a different guest")

    asset = _get_asset(db, comment.asset_id)
    validate_asset_in_share(db, link, asset)

    comment.deleted_at = datetime.now(timezone.utc)
    db.commit()
