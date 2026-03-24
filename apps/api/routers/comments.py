import re
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..middleware.auth import get_current_user, get_optional_user
from ..middleware.share_auth import get_share_link
from ..models.asset import Asset
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
)
from ..services import s3_service
from ..services.permissions import require_asset_access, validate_share_link
from ..tasks.email_tasks import send_mention_email, send_comment_email
from ..tasks.celery_app import send_task_safe

router = APIRouter(tags=["comments"])


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
    if visibility and visibility in ("public", "internal"):
        query = query.filter(Comment.visibility == visibility)
    top_level = query.order_by(Comment.created_at).all()
    return [_build_comment_response(c, db, current_user_id=current_user.id) for c in top_level]


@router.post("/assets/{asset_id}/comments", response_model=CommentResponse, status_code=status.HTTP_201_CREATED)
def create_comment(
    asset_id: uuid.UUID,
    body: CommentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = _get_asset(db, asset_id)
    require_asset_access(db, asset, current_user)

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
    return _build_comment_response(comment, db, current_user_id=current_user.id)


@router.post("/assets/{asset_id}/comments/{comment_id}/replies", response_model=CommentResponse, status_code=status.HTTP_201_CREATED)
def reply_to_comment(
    asset_id: uuid.UUID,
    comment_id: uuid.UUID,
    body: CommentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = _get_asset(db, asset_id)
    require_asset_access(db, asset, current_user)
    parent = db.query(Comment).filter(Comment.id == comment_id, Comment.deleted_at.is_(None)).first()
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
    from ..services.permissions import get_project_member
    is_comment_author = comment.author_id == current_user.id
    if not is_comment_author:
        pm = get_project_member(db, asset.project_id, current_user.id)
        if not pm or pm.role not in (ProjectRole.owner, ProjectRole.editor):
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


# ── Guest comments (via share link) ───────────────────────────────────────────

@router.get("/share/{token}/comments")
def list_share_comments(
    token: str,
    asset_id: Optional[uuid.UUID] = None,
    db: Session = Depends(get_db),
):
    """Public endpoint — list comments for a shared asset. No auth required.
    For folder/project shares, pass asset_id as query param to get comments for a specific asset."""
    link = validate_share_link(db, token)

    # Determine the asset_id to list comments for
    target_asset_id = link.asset_id or asset_id
    if not target_asset_id:
        return {"comments": []}
    asset_id = target_asset_id

    # Get top-level comments for this asset
    top_level = db.query(Comment).filter(
        Comment.asset_id == asset_id,
        Comment.parent_id.is_(None),
        Comment.deleted_at.is_(None),
    ).order_by(Comment.created_at).all()

    comments = []
    for c in top_level:
        # Get guest author info
        guest_name = None
        guest_email = None
        author_name = None
        if c.guest_author_id:
            guest = db.query(GuestUser).filter(GuestUser.id == c.guest_author_id).first()
            if guest:
                guest_name = guest.name
                guest_email = guest.email
        elif c.author_id:
            from ..models.user import User as UserModel
            author = db.query(UserModel).filter(UserModel.id == c.author_id).first()
            if author:
                author_name = author.name

        # Get replies
        replies_data = []
        replies = db.query(Comment).filter(
            Comment.parent_id == c.id,
            Comment.deleted_at.is_(None),
        ).order_by(Comment.created_at).all()
        for r in replies:
            r_guest_name = None
            r_author_name = None
            if r.guest_author_id:
                rg = db.query(GuestUser).filter(GuestUser.id == r.guest_author_id).first()
                if rg: r_guest_name = rg.name
            elif r.author_id:
                ra = db.query(UserModel).filter(UserModel.id == r.author_id).first()
                if ra: r_author_name = ra.name
            replies_data.append({
                "id": str(r.id),
                "body": r.body,
                "guest_name": r_guest_name or r_author_name or "Anonymous",
                "author_name": r_author_name,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "timecode_start": r.timecode_start,
            })

        comments.append({
            "id": str(c.id),
            "body": c.body,
            "guest_name": guest_name or author_name or "Anonymous",
            "author_name": author_name,
            "guest_email": guest_email or "",
            "created_at": c.created_at.isoformat() if c.created_at else None,
            "timecode_start": c.timecode_start,
            "replies": replies_data,
        })

    return {"comments": comments}


@router.post("/share/{token}/comment", response_model=CommentResponse, status_code=status.HTTP_201_CREATED)
def guest_comment(
    token: str,
    body: GuestCommentCreate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_user),
):
    link = validate_share_link(db, token)

    # Check share link permission allows commenting
    if link.permission == SharePermission.view:
        raise HTTPException(status_code=403, detail="This share link does not allow commenting")

    # Resolve asset_id: from body, link, or error
    target_asset_id = body.asset_id or link.asset_id
    if not target_asset_id:
        raise HTTPException(status_code=400, detail="asset_id is required for folder/project shares")
    asset = _get_asset(db, target_asset_id)

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

    comment = Comment(
        asset_id=asset.id,
        version_id=version_id,
        parent_id=body.parent_id,
        author_id=author_id,
        guest_author_id=guest_author_id,
        timecode_start=body.timecode_start,
        timecode_end=body.timecode_end,
        body=body.body,
    )
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
    activity = ShareLinkActivity(
        share_link_id=link.id,
        action=ShareActivityAction.commented,
        actor_email=guest_email,
        actor_name=body.guest_name,
        asset_id=asset.id,
        asset_name=asset.name,
    )
    db.add(activity)
    db.commit()

    return _build_comment_response(comment, db)
