import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_optional_user
from ..models.user import User
from ..models.instance_branding import InstanceBranding
from ..routers.users import require_admin
from ..services.branding_service import reset_org_name_cache
from ..schemas.instance_branding import (
    InstanceBrandingUpdate,
    InstanceBrandingResponse,
    InstanceBrandingLogoUploadResponse,
)
from ..services import s3_service
from ..services.owned_keys import (
    INSTANCE_LOGO_SLOTS, instance_logo_prefix, is_instance_logo_key, sign_if_owned,
)

router = APIRouter(tags=["instance_branding"])

_SINGLETON_ID = uuid.UUID("00000000-0000-0000-0000-000000000002")

LOGO_TYPES = INSTANCE_LOGO_SLOTS


def _default_instance_branding() -> InstanceBranding:
    """A transient (never added to the session) row carrying the built-in defaults."""
    now = datetime.now(timezone.utc)
    return InstanceBranding(
        id=_SINGLETON_ID,
        org_name="FreeFrame",
        powered_by_freeframe=True,
        default_login_mode="magic_code",
        created_at=now,
        updated_at=now,
    )


def _get_or_create_instance_branding(db: Session) -> InstanceBranding:
    row = db.query(InstanceBranding).first()
    if row:
        return row
    row = _default_instance_branding()
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return db.query(InstanceBranding).first()
    db.refresh(row)
    return row


def _enrich_branding_response(branding: InstanceBranding) -> InstanceBrandingResponse:
    resp = InstanceBrandingResponse.model_validate(branding)
    # The public GET signs these for anonymous callers, so only a key the slot's
    # own upload step issued is signed. Anything else (a row written before the
    # check existed) is shown as an empty slot.
    for column in LOGO_TYPES.values():
        key = getattr(branding, column)
        owned = is_instance_logo_key(column, key)
        if not owned:
            setattr(resp, column, None)
        setattr(resp, column.replace("_key", "_url"), sign_if_owned(owned, key))
    return resp


@router.get("/instance/branding", response_model=InstanceBrandingResponse)
def get_instance_branding(
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_optional_user),
):
    """Anyone (login and share pages are unauthenticated): instance branding.

    Read-only: does not create the branding row. Returns the built-in defaults
    when no row exists yet — only PUT creates the singleton row.
    """
    branding = db.query(InstanceBranding).first() or _default_instance_branding()
    return _enrich_branding_response(branding)


@router.put("/instance/branding", response_model=InstanceBrandingResponse)
def upsert_instance_branding(
    body: InstanceBrandingUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Admin only: update instance branding."""
    update_data = body.model_dump(exclude_unset=True)

    # Each logo field is a storage key the public GET signs and a later replace
    # deletes, so only a key that slot's upload step issued is accepted. Null or
    # empty clears the slot. Checked before anything is written.
    for field in LOGO_TYPES.values():
        if field not in update_data:
            continue
        if not update_data[field]:
            update_data[field] = None
        elif not is_instance_logo_key(field, update_data[field]):
            raise HTTPException(
                status_code=422,
                detail=f"{field} must be a key issued by its logo upload",
            )

    branding = _get_or_create_instance_branding(db)

    # Collect the replaced keys and only drop them once the row that still points
    # at them is safely committed — a rollback would otherwise leave the branding
    # referencing an S3 object we already deleted. Only a key the slot issued is
    # ever deleted: a stored value from before that was checked can name any object.
    replaced_keys = []
    for field, value in update_data.items():
        if field in LOGO_TYPES.values():
            old_key = getattr(branding, field)
            if old_key and old_key != value and is_instance_logo_key(field, old_key):
                replaced_keys.append(old_key)
        setattr(branding, field, value)

    db.commit()
    db.refresh(branding)
    # Drops this process's cached org name. The Celery workers that actually
    # render email hold their own copy and pick a rename up when their cache
    # expires, so email follows within the TTL rather than instantly.
    reset_org_name_cache()
    for old_key in replaced_keys:
        try:
            s3_service.delete_object(old_key)
        except Exception:
            pass
    return _enrich_branding_response(branding)


@router.post(
    "/instance/branding/{logo_type}-upload",
    response_model=InstanceBrandingLogoUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
def get_logo_upload_url(
    logo_type: str,
    content_type: str = Query(
        default=None,
        description="MIME type of the logo file (e.g. image/png). If omitted, ContentType is not included in the presigned signature — S3 will accept any MIME type the browser sends.",
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Admin only: presigned PUT URL for a branding logo slot."""
    if logo_type not in LOGO_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid logo type. Must be one of: {', '.join(LOGO_TYPES.keys())}"
        )
    key = f"{instance_logo_prefix(logo_type)}{uuid.uuid4()}"
    upload_url = s3_service.generate_presigned_put_url(key, content_type=content_type, expires_in=3600)
    return InstanceBrandingLogoUploadResponse(upload_url=upload_url, key=key)


@router.delete("/instance/branding/logo/{logo_type}", status_code=status.HTTP_200_OK)
def reset_logo(
    logo_type: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Admin only: clear a branding logo slot."""
    column = LOGO_TYPES.get(logo_type)
    if not column:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid logo type. Must be one of: {', '.join(LOGO_TYPES.keys())}"
        )
    branding = _get_or_create_instance_branding(db)
    old_key = getattr(branding, column)
    setattr(branding, column, None)
    db.commit()
    db.refresh(branding)
    # Only after the cleared row is committed: an orphaned object beats a row
    # pointing at an object that no longer exists. And only a key this slot
    # issued: a stored value from before that was checked can name any object.
    if is_instance_logo_key(column, old_key):
        try:
            s3_service.delete_object(old_key)
        except Exception:
            pass
    return _enrich_branding_response(branding)
