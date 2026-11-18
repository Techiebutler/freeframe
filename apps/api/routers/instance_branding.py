"""Public reads and administrator-managed values for global instance branding."""

import uuid
from datetime import datetime, timezone
from urllib.parse import quote
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..middleware.auth import get_optional_user
from ..models.user import User
from ..models.instance_branding import DEFAULT_INSTANCE_ORG_NAME, InstanceBranding
from ..routers.users import require_admin
from ..services.branding_service import reset_org_name_cache
from ..schemas.instance_branding import (
    InstanceBrandingAssetConfirm,
    InstanceBrandingUpdate,
    InstanceBrandingResponse,
    InstanceBrandingLogoUploadResponse,
)
from ..services import s3_service
from ..services.owned_keys import (
    INSTANCE_LOGO_SLOTS, instance_logo_prefix, is_instance_logo_key,
)

router = APIRouter(tags=["instance_branding"])

# A deterministic key makes concurrent first writes contend for one row instead
# of creating duplicate singleton settings.
_SINGLETON_ID = uuid.UUID("00000000-0000-0000-0000-000000000002")

LOGO_TYPES = INSTANCE_LOGO_SLOTS

# MIME types each slot accepts. An upload that names its type is refused unless
# the type is on the slot's list, and the presigned PUT is pinned to it.
_ASSET_MIME_TYPES = {
    "logo-light": {"image/png", "image/jpeg", "image/webp", "image/svg+xml"},
    "logo-dark": {"image/png", "image/jpeg", "image/webp", "image/svg+xml"},
    "favicon": {"image/png", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"},
    "apple-icon": {"image/png", "image/jpeg", "image/webp"},
    "login-logo": {"image/png", "image/jpeg", "image/webp", "image/svg+xml"},
}


def _default_instance_branding() -> InstanceBranding:
    """A transient (never added to the session) row carrying the built-in defaults."""
    now = datetime.now(timezone.utc)
    return InstanceBranding(
        id=_SINGLETON_ID,
        org_name=DEFAULT_INSTANCE_ORG_NAME,
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


# A logo URL is a stable path into this API rather than a signed link, so the
# browser, the web app's persisted store and server-rendered HTML can all keep it.
# The path redirects to a freshly signed link. The redirect may be cached for an
# hour, well inside the link's own lifetime, so a cached one never points at an
# expired signature.
LOGO_REDIRECT_MAX_AGE = 3600
LOGO_SIGNED_URL_TTL = 24 * 3600


def _logo_path(logo_type: str, key: str) -> str:
    # The key's last segment is new on every upload, so a replaced logo gets a new
    # URL and nothing cached under the old one is shown.
    return f"/instance/branding/logo/{logo_type}?v={quote(key.rsplit('/', 1)[-1], safe='')}"


def _enrich_branding_response(branding: InstanceBranding) -> InstanceBrandingResponse:
    resp = InstanceBrandingResponse.model_validate(branding)
    # The public logo route signs these for anonymous callers, so only a key the
    # slot's own upload step issued gets a URL. Anything else (a row written
    # before the check existed) is shown as an empty slot.
    for logo_type, column in LOGO_TYPES.items():
        key = getattr(branding, column)
        owned = is_instance_logo_key(column, key)
        if not owned:
            setattr(resp, column, None)
        setattr(resp, column.replace("_key", "_url"), _logo_path(logo_type, key) if owned else None)
    return resp


def _check_asset_size(key: str) -> None:
    """Refuse an uploaded logo that is missing or over INSTANCE_BRANDING_MAX_ASSET_BYTES.

    Runs before the key is stored, so an oversized object never becomes the
    public logo that every login and share page loads.
    """
    try:
        size = s3_service.head_object_size(key)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Uploaded branding asset could not be checked") from exc
    if size is None:
        raise HTTPException(status_code=400, detail="Uploaded branding asset was not found")
    if size > settings.instance_branding_max_asset_bytes:
        raise HTTPException(status_code=400, detail="Uploaded branding asset is too large")


def _delete_owned(column: str, keys: list) -> None:
    """Delete replaced logo objects, only after the row no longer points at them.

    Only a key the slot issued is ever deleted: a stored value from before that
    was checked can name any object.
    """
    for key in keys:
        if not is_instance_logo_key(column, key):
            continue
        try:
            s3_service.delete_object(key)
        except Exception:
            pass


@router.get("/instance/branding", response_model=InstanceBrandingResponse)
def get_instance_branding(
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_optional_user),
):
    """Anyone (login and share pages are unauthenticated): instance branding.

    Read-only: does not create the branding row. Returns the built-in defaults
    when no row exists yet — only a write creates the singleton row.
    """
    branding = db.query(InstanceBranding).first() or _default_instance_branding()
    return _enrich_branding_response(branding)


@router.get("/instance/branding/logo/{logo_type}")
def get_logo(logo_type: str, db: Session = Depends(get_db)):
    """Anyone: redirect to a freshly signed link for a branding logo slot.

    This is the URL `GET /instance/branding` hands out for each logo. The `v`
    query parameter only busts caches after a re-upload; the slot's current
    logo is always what is served.
    """
    column = LOGO_TYPES.get(logo_type)
    branding = db.query(InstanceBranding).first() if column else None
    key = getattr(branding, column) if branding else None
    if not is_instance_logo_key(column, key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Logo not found")
    url = s3_service.generate_presigned_get_url(key, expires_in=LOGO_SIGNED_URL_TTL)
    return RedirectResponse(
        url,
        status_code=status.HTTP_302_FOUND,
        headers={"Cache-Control": f"public, max-age={LOGO_REDIRECT_MAX_AGE}"},
    )


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

    # A newly set logo must exist and fit the size cap. A key the row already
    # holds was checked when it was stored.
    for field in LOGO_TYPES.values():
        value = update_data.get(field)
        if value and value != getattr(branding, field):
            _check_asset_size(value)

    # Collect the replaced keys and only drop them once the row that still points
    # at them is safely committed — a rollback would otherwise leave the branding
    # referencing an S3 object we already deleted.
    replaced = []
    for field, value in update_data.items():
        if field in LOGO_TYPES.values():
            old_key = getattr(branding, field)
            if old_key and old_key != value:
                replaced.append((field, old_key))
        setattr(branding, field, value)

    db.commit()
    db.refresh(branding)
    # Drops this process's cached org name. The Celery workers that actually
    # render email hold their own copy and pick a rename up when their cache
    # expires, so email follows within the TTL rather than instantly.
    reset_org_name_cache()
    for field, old_key in replaced:
        _delete_owned(field, [old_key])
    return _enrich_branding_response(branding)


@router.delete("/instance/branding", response_model=InstanceBrandingResponse)
def reset_instance_branding(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Admin only: restore the built-in name, colour, footer and logos.

    The login mode is an access setting rather than branding and is left as is.
    Asset deletion happens only after the reset has committed, so a failed
    transaction never leaves a saved row pointing to a deleted object.
    """
    branding = _get_or_create_instance_branding(db)
    branding.org_name = DEFAULT_INSTANCE_ORG_NAME
    branding.primary_color = None
    branding.powered_by_freeframe = True
    old_keys = [(column, getattr(branding, column)) for column in LOGO_TYPES.values() if getattr(branding, column)]
    for column in LOGO_TYPES.values():
        setattr(branding, column, None)
    db.commit()
    db.refresh(branding)
    reset_org_name_cache()
    for column, key in old_keys:
        _delete_owned(column, [key])
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
        description="MIME type of the logo file (e.g. image/png). It must be one the slot accepts, and the upload is then pinned to it. If omitted, ContentType is not included in the presigned signature — S3 will accept any MIME type the browser sends.",
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
    if content_type is not None:
        content_type = content_type.split(";", 1)[0].strip().lower()
        if content_type not in _ASSET_MIME_TYPES[logo_type]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unsupported branding asset type",
            )
    key = f"{instance_logo_prefix(logo_type)}{uuid.uuid4()}"
    upload_url = s3_service.generate_presigned_put_url(key, content_type=content_type, expires_in=3600)
    return InstanceBrandingLogoUploadResponse(upload_url=upload_url, key=key)


@router.post("/instance/branding/{logo_type}-confirm", response_model=InstanceBrandingResponse)
def confirm_logo_upload(
    logo_type: str,
    body: InstanceBrandingAssetConfirm,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Admin only: verify an uploaded logo's type and size, then make it the slot's logo.

    The same outcome as `PUT /instance/branding` with the key, plus a check of the
    stored object's Content-Type against what the slot accepts.
    """
    column = LOGO_TYPES.get(logo_type)
    if not column or not is_instance_logo_key(column, body.key):
        raise HTTPException(status_code=400, detail="Invalid branding asset key")
    try:
        metadata = s3_service.get_s3_client().head_object(Bucket=settings.s3_bucket, Key=body.key)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Uploaded branding asset was not found") from exc
    content_type = (metadata.get("ContentType") or "").split(";", 1)[0].strip().lower()
    if (
        content_type not in _ASSET_MIME_TYPES[logo_type]
        or metadata.get("ContentLength", 0) > settings.instance_branding_max_asset_bytes
    ):
        raise HTTPException(status_code=400, detail="Uploaded branding asset failed validation")
    branding = _get_or_create_instance_branding(db)
    old_key = getattr(branding, column)
    setattr(branding, column, body.key)
    db.commit()
    db.refresh(branding)
    if old_key and old_key != body.key:
        _delete_owned(column, [old_key])
    return _enrich_branding_response(branding)


def _clear_logo(column: str, db: Session) -> InstanceBrandingResponse:
    branding = _get_or_create_instance_branding(db)
    old_key = getattr(branding, column)
    setattr(branding, column, None)
    db.commit()
    db.refresh(branding)
    # Only after the cleared row is committed: an orphaned object beats a row
    # pointing at an object that no longer exists.
    if old_key:
        _delete_owned(column, [old_key])
    return _enrich_branding_response(branding)


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
    return _clear_logo(column, db)


@router.delete("/instance/branding/{logo_type}", response_model=InstanceBrandingResponse)
def remove_logo(
    logo_type: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Admin only: older path for clearing a logo slot (same as `/instance/branding/logo/{slot}`)."""
    column = LOGO_TYPES.get(logo_type)
    if not column:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown branding asset slot")
    return _clear_logo(column, db)
