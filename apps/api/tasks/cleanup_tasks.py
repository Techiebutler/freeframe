import logging
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta

from .celery_app import celery_app
from ..database import SessionLocal
from ..config import settings
from ..models.asset import (
    Asset, AssetVersion, MediaFile, CarouselItem, ProcessingStatus,
)
from ..models.comment import Comment, Annotation, CommentAttachment, CommentReaction
from ..models.approval import Approval
from ..models.share import ShareLink, ShareLinkItem, ShareLinkActivity, AssetShare
from ..models.project import Project, ProjectMember
from ..models.folder import Folder
from ..models.metadata import MetadataField, AssetMetadata, Collection, CollectionShare
from ..models.branding import ProjectBranding, WatermarkSettings
from ..models.activity import Mention, ActivityLog, Notification
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


@dataclass
class PurgeCounts:
    """Accumulates what a purge run reclaimed. `retention_days` is filled by `_run_cleanup`."""
    retention_days: int = 0
    projects: int = 0
    folders: int = 0
    assets: int = 0
    versions: int = 0
    media_files: int = 0
    comments: int = 0
    share_links: int = 0
    share_links_expired: int = 0
    s3_deletes: int = 0


def _purge_comment(db, comment_id, counts: PurgeCounts) -> None:
    """Hard-delete a comment and its whole subtree (replies, annotations, attachments (+S3),
    reactions, mentions, comment-scoped notifications). Mutates db; does NOT commit."""
    c = db.query(Comment).filter(Comment.id == comment_id).first()
    if c is None:
        return  # already removed by an overlapping root/recursion
    for reply in db.query(Comment).filter(Comment.parent_id == comment_id).all():
        _purge_comment(db, reply.id, counts)
    for att in db.query(CommentAttachment).filter(CommentAttachment.comment_id == comment_id).all():
        _safe(delete_object, att.s3_key)
        counts.s3_deletes += 1
    db.query(CommentAttachment).filter(CommentAttachment.comment_id == comment_id).delete(synchronize_session=False)
    db.query(Annotation).filter(Annotation.comment_id == comment_id).delete(synchronize_session=False)
    db.query(CommentReaction).filter(CommentReaction.comment_id == comment_id).delete(synchronize_session=False)
    db.query(Mention).filter(Mention.comment_id == comment_id).delete(synchronize_session=False)
    db.query(Notification).filter(Notification.comment_id == comment_id).delete(synchronize_session=False)
    db.query(Comment).filter(Comment.id == comment_id).delete(synchronize_session=False)
    counts.comments += 1
    db.flush()


def _reclaim_media_s3(mf, counts: PurgeCounts) -> None:
    """Best-effort delete of a MediaFile's S3 objects. processed is a prefix (HLS or single key)."""
    _safe(delete_object, mf.s3_key_raw)
    counts.s3_deletes += 1
    if mf.s3_key_processed:
        _safe(delete_prefix, mf.s3_key_processed)
        counts.s3_deletes += 1
    if mf.s3_key_thumbnail:
        _safe(delete_object, mf.s3_key_thumbnail)
        counts.s3_deletes += 1


def _purge_version(db, version_id, counts: PurgeCounts) -> None:
    """Hard-delete a version's media (+S3), carousel items, comments and approvals, then the row."""
    v = db.query(AssetVersion).filter(AssetVersion.id == version_id).first()
    if v is None:
        return
    # carousel items reference media_file_id + version_id — remove before media files
    db.query(CarouselItem).filter(CarouselItem.version_id == version_id).delete(synchronize_session=False)
    media = db.query(MediaFile).filter(MediaFile.version_id == version_id).all()
    for mf in media:
        _reclaim_media_s3(mf, counts)
    counts.media_files += len(media)
    db.query(MediaFile).filter(MediaFile.version_id == version_id).delete(synchronize_session=False)
    # comments on this version (recurse each; every comment has a version_id, NOT NULL)
    for c in db.query(Comment).filter(Comment.version_id == version_id).all():
        _purge_comment(db, c.id, counts)
    db.query(Approval).filter(Approval.version_id == version_id).delete(synchronize_session=False)
    db.query(AssetVersion).filter(AssetVersion.id == version_id).delete(synchronize_session=False)
    counts.versions += 1
    db.flush()


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
