from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models.asset import Asset, AssetVersion, MediaFile, ProcessingStatus
from ..models.instance_settings import InstanceSettings
from ..schemas.upload import _format_bytes, upload_size_error


def get_storage_limit(db: Session) -> int:
    """Non-creating read of the instance storage cap. 0 (or no row) == unlimited."""
    row = db.query(InstanceSettings).first()
    return row.storage_limit_bytes if row else 0


def instance_storage_used_bytes(db: Session) -> int:
    """Instance-wide committed storage in bytes — the single source of truth for both
    the member GET indicator and cap enforcement.

    Counts only bytes actually in S3: versions in `processing`/`ready`, excluding
    soft-deleted assets/versions. MediaFile has no deleted_at, so soft-delete is
    excluded via the Asset/AssetVersion join filters.
    """
    return db.query(func.coalesce(func.sum(MediaFile.file_size_bytes), 0)) \
        .join(AssetVersion, MediaFile.version_id == AssetVersion.id) \
        .join(Asset, AssetVersion.asset_id == Asset.id) \
        .filter(
            Asset.deleted_at.is_(None),
            AssetVersion.deleted_at.is_(None),
            AssetVersion.processing_status.in_(
                [ProcessingStatus.processing, ProcessingStatus.ready]
            ),
        ).scalar() or 0


def storage_cap_error(db: Session, incoming_bytes: int) -> str | None:
    """Return an error detail if accepting `incoming_bytes` would exceed the instance
    storage cap, else None. Limit 0 (unlimited) short-circuits before any usage query.
    """
    limit = get_storage_limit(db)
    if not limit:
        return None
    used = instance_storage_used_bytes(db)
    if used + incoming_bytes > limit:
        return f"Storage limit reached — {_format_bytes(used)} of {_format_bytes(limit)} used"
    return None


def upload_guard_error(db: Session, file_size_bytes: int) -> str | None:
    """Combined pre-upload guard: the per-file cap (env `MAX_UPLOAD_BYTES`) first, then the
    instance-wide storage cap (DB). Returns the first error message, or None if both pass."""
    return upload_size_error(file_size_bytes) or storage_cap_error(db, file_size_bytes)
