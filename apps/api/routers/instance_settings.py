import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from packages.transcoder.base import crf_offset_for_level, level_for_crf_offset
from packages.transcoder.ffmpeg_transcoder import get_crf_offset

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


def effective_crf_offset(row: InstanceSettings | None) -> int:
    """The CRF offset the next transcode will use.

    The chosen level when there is one, and `TRANSCODER_CRF_OFFSET` when there
    is not. The same precedence the worker applies, in one place, so the number
    the settings page shows is the number the encoder gets.
    """
    chosen = crf_offset_for_level(row.compression_level if row else None)
    return chosen if chosen is not None else get_crf_offset()


def _build_response(db: Session, row: InstanceSettings | None, user: User) -> InstanceSettingsResponse:
    """`row` is None before the first PUT creates it, which reads as the defaults."""
    offset = effective_crf_offset(row) if user.is_superadmin else None
    return InstanceSettingsResponse(
        storage_limit_bytes=row.storage_limit_bytes if row else 0,
        storage_used_bytes=storage_service.instance_storage_used_bytes(db),
        upload_part_size_bytes=(
            (row.upload_part_size_bytes if row else 0) if user.is_superadmin else None
        ),
        allow_original_downloads=(
            (row.allow_original_downloads if row else False) if user.is_superadmin else None
        ),
        compression_level=(
            (row.compression_level if row else None) if user.is_superadmin else None
        ),
        compression_crf_offset=offset,
        # The step the effective offset sits on, computed from the one scale in
        # packages/transcoder/base.py. None when no step names the offset,
        # which is how the UI knows to say so.
        compression_level_effective=(
            level_for_crf_offset(offset) if offset is not None else None
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
    also get the upload part size and whether outsiders may download originals.

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
    if body.allow_original_downloads is not None:
        row.allow_original_downloads = body.allow_original_downloads
    # Presence of the key, not `is not None`, and only for this field: null is
    # a real instruction here ("go back to following TRANSCODER_CRF_OFFSET"),
    # which is why the column is nullable. Without it the setting is a one-way
    # door only psql can reopen. The other fields keep "null leaves it alone".
    if "compression_level" in body.model_fields_set:
        row.compression_level = body.compression_level
    db.commit()
    db.refresh(row)
    return _build_response(db, row, current_user)
