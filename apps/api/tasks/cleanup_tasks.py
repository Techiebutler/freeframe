import logging
from datetime import datetime, timezone, timedelta

from .celery_app import celery_app
from ..database import SessionLocal
from ..config import settings
from ..models.asset import AssetVersion, MediaFile, ProcessingStatus
from ..services.s3_service import (
    list_stale_multipart_uploads, abort_multipart_upload, delete_object, delete_prefix,
)

log = logging.getLogger("celery.cleanup")


def _safe(fn, *args):
    """Run a best-effort S3 op; log and swallow any error so the sweep never aborts."""
    try:
        fn(*args)
    except Exception as exc:  # noqa: BLE001 - best-effort cleanup
        log.warning("reaper: %s%r failed: %s", fn.__name__, args, exc)


def _reap_stale_uploads(db) -> int:
    """Reclaim upload orphans. Mutates `db` (soft-deletes versions) but does NOT commit —
    the caller owns the transaction. Returns the number of versions soft-deleted."""
    hours = settings.stale_upload_timeout_hours
    if hours <= 0:
        # 0 (or negative) DISABLES the reaper — matching the 0 = unlimited/disabled convention
        # of MAX_UPLOAD_BYTES / storage_limit_bytes. Without this guard, cutoff would be `now()`
        # and the sweep would destroy every in-progress upload on the next run.
        log.info("reaper: disabled (stale_upload_timeout_hours=%s)", hours)
        return 0
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

    # 1. Abort stale, still-open multipart uploads (reclaims uploaded parts).
    for key, upload_id in list_stale_multipart_uploads(cutoff):
        _safe(abort_multipart_upload, key, upload_id)

    # 2. Reclaim stuck `uploading` / `failed` versions past the cutoff.
    versions = db.query(AssetVersion).filter(
        AssetVersion.processing_status.in_([ProcessingStatus.uploading, ProcessingStatus.failed]),
        AssetVersion.deleted_at.is_(None),
        AssetVersion.created_at < cutoff,
    ).all()
    for v in versions:
        for mf in db.query(MediaFile).filter(MediaFile.version_id == v.id).all():
            _safe(delete_object, mf.s3_key_raw)
            if mf.s3_key_processed:
                _safe(delete_prefix, mf.s3_key_processed)
            if mf.s3_key_thumbnail:
                _safe(delete_object, mf.s3_key_thumbnail)
        v.deleted_at = datetime.now(timezone.utc)
    log.info("reaper: soft-deleted %d stale version(s)", len(versions))
    return len(versions)


@celery_app.task(name="reap_stale_uploads")
def reap_stale_uploads():
    """Periodic beat task: reclaim storage from stuck/failed uploads."""
    db = SessionLocal()
    try:
        n = _reap_stale_uploads(db)
        db.commit()
        return n
    finally:
        db.close()
