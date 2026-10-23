from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
import uuid
import secrets
from datetime import datetime, timezone, timedelta
from ..database import get_db
from ..schemas.auth import (
    UserResponse, AdminUserResponse, InviteRequest, UpdateProfileRequest,
)
from ..models.user import User, UserStatus
from ..middleware.auth import get_current_user
from ..services.auth_service import hash_password, get_email_owner
from ..tasks.email_tasks import send_invite_email
from ..tasks.celery_app import send_task_safe
from ..models.instance_branding import InstanceBranding
from ..config import settings
from ..services import s3_service
from ..services.avatar_keys import delete_own_avatar, is_own_avatar_key
from ..services.search import escape_like

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[UserResponse])
def get_users_batch(
    ids: str = Query(..., description="Comma-separated user IDs"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get basic user info for a batch of user IDs. Any authenticated user can call this."""
    try:
        user_ids = [uuid.UUID(uid.strip()) for uid in ids.split(",") if uid.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid user ID format")
    if len(user_ids) > 100:
        raise HTTPException(status_code=400, detail="Max 100 user IDs per request")
    users = db.query(User).filter(User.id.in_(user_ids), User.deleted_at.is_(None)).all()
    return users


@router.get("/search", response_model=list[UserResponse])
def search_users(
    q: str = Query(..., min_length=1, description="Search by name or email"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Search users by name or email. Returns up to 10 matching users."""
    pattern = f"%{escape_like(q)}%"
    users = db.query(User).filter(
        User.deleted_at.is_(None),
        (User.name.ilike(pattern) | User.email.ilike(pattern)),
    ).limit(10).all()
    return users


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.is_superadmin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user

@router.post("/invite", response_model=AdminUserResponse, status_code=status.HTTP_201_CREATED)
def invite_user(body: InviteRequest, db: Session = Depends(get_db), current_user: User = Depends(require_admin)):
    # Soft-deleted rows count: the unique constraint on users.email still covers
    # them, so skipping them here turns the INSERT into a 500. Any case counts
    # too, or Bob@ could be invited next to bob@ as a second account.
    existing = get_email_owner(db, body.email)
    if existing and existing.deleted_at is not None:
        raise HTTPException(
            status_code=400,
            detail="This email belonged to a deleted user and can't be invited again",
        )
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    # Generate invite token
    invite_token = secrets.token_urlsafe(48)
    invite_expires = datetime.now(timezone.utc) + timedelta(days=7)
    
    user = User(
        email=body.email,
        name=body.name,
        status=UserStatus.pending_invite,
        invite_token=invite_token,
        invite_token_expires_at=invite_expires,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    
    # Send invite email
    invite_url = f"{settings.frontend_url}/invite/{invite_token}"
    branding = db.query(InstanceBranding).first()
    org_name = branding.org_name if branding else "FreeFrame"
    send_task_safe(send_invite_email, user.email, current_user.name or "Admin", org_name, invite_url)
    
    return user

@router.patch("/{user_id}", response_model=UserResponse)
def update_user(user_id: uuid.UUID, body: UpdateProfileRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Update user profile. Users can update their own profile."""
    if current_user.id != user_id and not current_user.is_superadmin:
        raise HTTPException(status_code=403, detail="Can only update your own profile")
    user = db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if body.name is not None:
        # Already trimmed and checked non-blank by `DisplayName`.
        user.name = body.name
    if "avatar_color" in body.model_fields_set:
        # An explicit null resets to the default colour; omitting it leaves it.
        user.avatar_color = body.avatar_color
    db.commit()
    db.refresh(user)
    return user



# The frontend crops and re-encodes every avatar before upload, so these are
# the only types it sends. Anything else is refused rather than signed: the
# object is served back from the bucket with whatever type it was stored as.
AVATAR_CONTENT_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
}
# The upload link is short-lived because the size check runs once, at confirm:
# for as long as the link works, the same key could be uploaded again, larger.
# The browser uses it within seconds of asking.
AVATAR_UPLOAD_LINK_SECONDS = 300
# The frontend uploads a 256px square, a few tens of KB. The ceiling is only
# there so a client calling the API directly can't make every avatar on every
# comment a multi-megabyte download.
AVATAR_MAX_BYTES = 2 * 1024 * 1024


def _get_own_user(db: Session, user_id: uuid.UUID, current_user: User, detail: str) -> User:
    """The target user, if the caller is that user or a superadmin."""
    if current_user.id != user_id and not current_user.is_superadmin:
        raise HTTPException(status_code=403, detail=detail)
    user = db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.post("/{user_id}/avatar-upload", status_code=status.HTTP_201_CREATED)
def get_avatar_upload_url(
    user_id: uuid.UUID,
    content_type: str = Query(default="image/png", description="MIME type of the avatar file: image/png, image/jpeg or image/webp"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Generate a presigned S3 URL for uploading a profile avatar."""
    _get_own_user(db, user_id, current_user, "Can only upload your own avatar")
    ext = AVATAR_CONTENT_TYPES.get(content_type)
    if not ext:
        raise HTTPException(
            status_code=400,
            detail=f"Avatar must be one of: {', '.join(AVATAR_CONTENT_TYPES)}",
        )
    key = f"avatars/{user_id}/{uuid.uuid4()}.{ext}"
    upload_url = s3_service.generate_presigned_put_url(
        key, content_type=content_type, expires_in=AVATAR_UPLOAD_LINK_SECONDS,
    )
    return {"upload_url": upload_url, "key": key}


@router.post("/{user_id}/avatar-confirm", response_model=UserResponse)
def confirm_avatar_upload(
    user_id: uuid.UUID,
    body: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Confirm avatar upload: point the user at the uploaded object."""
    user = _get_own_user(db, user_id, current_user, "Can only update your own avatar")
    s3_key = body.get("key")
    if not s3_key:
        raise HTTPException(status_code=400, detail="key is required")
    if not isinstance(s3_key, str) or not is_own_avatar_key(user.id, s3_key):
        raise HTTPException(status_code=400, detail="Invalid key for this user")
    try:
        size = s3_service.head_object_size(s3_key)
    except s3_service.ObjectSizeUnavailable:
        # The object is there, storage just won't say how big. The cap is a
        # guard against direct API callers, not worth refusing a real upload.
        size = 0
    except (ClientError, BotoCoreError):
        raise HTTPException(status_code=503, detail="Could not check the upload, try again")
    if size is None:
        raise HTTPException(status_code=400, detail="Avatar upload not found")
    if size > AVATAR_MAX_BYTES:
        delete_own_avatar(user.id, s3_key)
        raise HTTPException(status_code=400, detail="Avatar must be under 2 MB")
    old_key = user.avatar_url
    user.avatar_url = s3_key
    db.commit()
    db.refresh(user)
    # Only ever removes this user's own previous avatar. The stored value is
    # not trusted on its own: a row written before this check existed can name
    # any object in the bucket.
    if old_key != s3_key:
        delete_own_avatar(user.id, old_key)
    return user


@router.delete("/{user_id}/avatar", response_model=UserResponse)
def remove_avatar(
    user_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove the user's profile picture; they fall back to initials."""
    user = _get_own_user(db, user_id, current_user, "Can only remove your own avatar")
    old_key = user.avatar_url
    user.avatar_url = None
    db.commit()
    db.refresh(user)
    # After the commit, and only if the stored key is this user's own: a row
    # written before the key guard existed can name any object in the bucket.
    delete_own_avatar(user.id, old_key)
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(user_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(require_admin)):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot delete yourself")
    user = db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    # Deleting a pending invitee is how the admin page revokes an invite, so it
    # needs no deactivation first; anyone else does.
    if user.status not in (UserStatus.deactivated, UserStatus.pending_invite):
        raise HTTPException(status_code=409, detail="Deactivate this user before deleting them")
    user.deleted_at = datetime.now(timezone.utc)
    user.invite_token = None
    user.invite_token_expires_at = None
    # The picture goes with the account: their comments show initials, and the
    # object is reclaimed rather than left in the bucket for good. A deleted
    # user can't be restored, so nothing would ever need it again.
    old_key = user.avatar_url
    user.avatar_url = None
    db.commit()
    delete_own_avatar(user.id, old_key)
