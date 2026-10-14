import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.instance_settings import InstanceSettings
from ..routers.users import require_admin
from ..schemas.instance_settings import InstanceSettingsUpdate, InstanceSettingsResponse
from ..services import storage as storage_service

router = APIRouter(tags=["instance_settings"])

# Fixed sentinel PK: instance_settings is a singleton. Concurrent first-time creates
# collide on this PK (IntegrityError) instead of producing duplicate rows.
_SINGLETON_ID = uuid.UUID("00000000-0000-0000-0000-000000000001")


def get_or_create_instance_settings(db: Session) -> InstanceSettings:
    row = db.query(InstanceSettings).first()
    if row:
        return row
    row = InstanceSettings(id=_SINGLETON_ID)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return db.query(InstanceSettings).first()
    db.refresh(row)
    return row


def _build_response(db: Session, row: InstanceSettings | None, user: User) -> InstanceSettingsResponse:
    """`row` is None before the first PUT creates it, which reads as the defaults."""
    return InstanceSettingsResponse(
        storage_limit_bytes=row.storage_limit_bytes if row else 0,
        storage_used_bytes=storage_service.instance_storage_used_bytes(db),
        upload_part_size_bytes=(
            (row.upload_part_size_bytes if row else 0) if user.is_superadmin else None
        ),
    )


# exclude_none: a member gets no admin-only key at all, rather than a null in
# its place (see InstanceSettingsResponse).
@router.get("/instance/settings", response_model=InstanceSettingsResponse, response_model_exclude_none=True)
def get_instance_settings(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Any authenticated member: instance storage limit + current usage. Admins
    also get the upload part size.

    Read-only: does not create the settings row. Defaults to unlimited (0) and
    automatic part sizing (0) when no row exists yet — only PUT creates the
    singleton row.
    """
    return _build_response(db, db.query(InstanceSettings).first(), current_user)


@router.put("/instance/settings", response_model=InstanceSettingsResponse, response_model_exclude_none=True)
def update_instance_settings(
    body: InstanceSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Admin only: update instance settings."""
    row = get_or_create_instance_settings(db)
    if body.storage_limit_bytes is not None:
        row.storage_limit_bytes = body.storage_limit_bytes
    if body.upload_part_size_bytes is not None:
        row.upload_part_size_bytes = body.upload_part_size_bytes
    db.commit()
    db.refresh(row)
    return _build_response(db, row, current_user)
