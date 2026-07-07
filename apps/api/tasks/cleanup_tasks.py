import logging
from dataclasses import dataclass, asdict
from datetime import datetime, timezone, timedelta

from sqlalchemy import text

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
    list_stale_multipart_uploads, abort_multipart_upload, delete_object, delete_prefix, list_keys,
)

log = logging.getLogger("celery.cleanup")

_MAX_RETENTION_DAYS = 36500  # 100 years; guards timedelta OverflowError on absurd misconfig (e.g. seconds mistaken for days)
_PURGE_ADVISORY_LOCK_KEY = 5477651  # identifies the retention GC purge (pg advisory lock space)


def _retention_days() -> int:
    """Effective retention window in days, clamped to a sane max so a misconfigured huge value can't
    raise OverflowError and silently kill the GC. `<= 0` (disabled) is handled by callers and passes through."""
    days = settings.soft_delete_retention_days
    if days > _MAX_RETENTION_DAYS:
        log.warning("cleanup: soft_delete_retention_days=%s exceeds max %s; clamping", days, _MAX_RETENTION_DAYS)
        return _MAX_RETENTION_DAYS
    return days


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


def _purge_share_link(db, share_link_id, counts: PurgeCounts) -> None:
    """Hard-delete a share link and its items, activity, and watermark override."""
    link = db.query(ShareLink).filter(ShareLink.id == share_link_id).first()
    if link is None:
        return
    db.query(ShareLinkItem).filter(ShareLinkItem.share_link_id == share_link_id).delete(synchronize_session=False)
    db.query(ShareLinkActivity).filter(ShareLinkActivity.share_link_id == share_link_id).delete(synchronize_session=False)
    db.query(WatermarkSettings).filter(WatermarkSettings.share_link_id == share_link_id).delete(synchronize_session=False)
    db.query(ShareLink).filter(ShareLink.id == share_link_id).delete(synchronize_session=False)
    counts.share_links += 1
    db.flush()


def _purge_asset(db, asset_id, counts: PurgeCounts) -> None:
    """Hard-delete an asset and everything hanging off it."""
    a = db.query(Asset).filter(Asset.id == asset_id).first()
    if a is None:
        return
    for v in db.query(AssetVersion).filter(AssetVersion.asset_id == asset_id).all():
        _purge_version(db, v.id, counts)
    # defensive: comments not removed via a version (all comments have a version_id, so usually none)
    for c in db.query(Comment).filter(Comment.asset_id == asset_id).all():
        _purge_comment(db, c.id, counts)
    # defensive: Approval.version_id is NOT NULL, so _purge_version already removed these
    db.query(Approval).filter(Approval.asset_id == asset_id).delete(synchronize_session=False)
    db.query(AssetMetadata).filter(AssetMetadata.asset_id == asset_id).delete(synchronize_session=False)
    for link in db.query(ShareLink).filter(ShareLink.asset_id == asset_id).all():
        _purge_share_link(db, link.id, counts)
    # share-link items in OTHER (multi-asset) links that reference this asset
    db.query(ShareLinkItem).filter(ShareLinkItem.asset_id == asset_id).delete(synchronize_session=False)
    db.query(AssetShare).filter(AssetShare.asset_id == asset_id).delete(synchronize_session=False)
    db.query(ActivityLog).filter(ActivityLog.asset_id == asset_id).delete(synchronize_session=False)
    db.query(Notification).filter(Notification.asset_id == asset_id).delete(synchronize_session=False)
    db.query(Asset).filter(Asset.id == asset_id).delete(synchronize_session=False)
    counts.assets += 1
    db.flush()


def _purge_folder(db, folder_id, counts: PurgeCounts) -> None:
    """Hard-delete a folder, its nested folders, its assets, and folder-scoped shares."""
    f = db.query(Folder).filter(Folder.id == folder_id).first()
    if f is None:
        return
    child_ids = [c.id for c in db.query(Folder.id).filter(Folder.parent_id == folder_id).all()]
    for cid in child_ids:
        # re-check under lock: skip a child folder reparented out (e.g. restored to root) since the scan
        if db.query(Folder).filter(Folder.id == cid, Folder.parent_id == folder_id).with_for_update().first() is None:
            continue
        _purge_folder(db, cid, counts)
    asset_ids = [a.id for a in db.query(Asset.id).filter(Asset.folder_id == folder_id).all()]
    for aid in asset_ids:
        # re-check under lock: skip an asset reparented out (restored to root) since the scan
        if db.query(Asset).filter(Asset.id == aid, Asset.folder_id == folder_id).with_for_update().first() is None:
            continue
        _purge_asset(db, aid, counts)
    for link in db.query(ShareLink).filter(ShareLink.folder_id == folder_id).all():
        _purge_share_link(db, link.id, counts)
    db.query(ShareLinkItem).filter(ShareLinkItem.folder_id == folder_id).delete(synchronize_session=False)
    db.query(AssetShare).filter(AssetShare.folder_id == folder_id).delete(synchronize_session=False)
    db.query(Folder).filter(Folder.id == folder_id).delete(synchronize_session=False)
    counts.folders += 1
    db.flush()


def _purge_project(db, project_id, counts: PurgeCounts) -> None:
    """Hard-delete a project and its entire contents."""
    p = db.query(Project).filter(Project.id == project_id).first()
    if p is None:
        return
    # assets first (covers foldered + loose); folder loops below are then empty
    for a in db.query(Asset).filter(Asset.project_id == project_id).all():
        _purge_asset(db, a.id, counts)
    for f in db.query(Folder).filter(Folder.project_id == project_id, Folder.parent_id.is_(None)).all():
        _purge_folder(db, f.id, counts)
    # catch orphaned folders (folders.parent_id has no same-project constraint) not reachable from the project's root folders
    for f in db.query(Folder).filter(Folder.project_id == project_id).all():
        _purge_folder(db, f.id, counts)
    for link in db.query(ShareLink).filter(ShareLink.project_id == project_id).all():
        _purge_share_link(db, link.id, counts)
    field_ids = [mf.id for mf in db.query(MetadataField).filter(MetadataField.project_id == project_id).all()]
    if field_ids:
        db.query(AssetMetadata).filter(AssetMetadata.field_id.in_(field_ids)).delete(synchronize_session=False)
    db.query(MetadataField).filter(MetadataField.project_id == project_id).delete(synchronize_session=False)
    coll_ids = [c.id for c in db.query(Collection).filter(Collection.project_id == project_id).all()]
    if coll_ids:
        db.query(CollectionShare).filter(CollectionShare.collection_id.in_(coll_ids)).delete(synchronize_session=False)
    db.query(Collection).filter(Collection.project_id == project_id).delete(synchronize_session=False)
    branding = db.query(ProjectBranding).filter(ProjectBranding.project_id == project_id).first()
    if branding is not None:
        if branding.logo_s3_key:
            _safe(delete_object, branding.logo_s3_key)
            counts.s3_deletes += 1
        db.query(ProjectBranding).filter(ProjectBranding.project_id == project_id).delete(synchronize_session=False)
    db.query(WatermarkSettings).filter(WatermarkSettings.project_id == project_id).delete(synchronize_session=False)
    db.query(ProjectMember).filter(ProjectMember.project_id == project_id).delete(synchronize_session=False)
    db.query(ActivityLog).filter(ActivityLog.project_id == project_id).delete(synchronize_session=False)
    if p.poster_s3_key:
        _safe(delete_object, p.poster_s3_key)
        counts.s3_deletes += 1
    db.query(Project).filter(Project.id == project_id).delete(synchronize_session=False)
    counts.projects += 1
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


def _expire_share_links(db, counts: PurgeCounts) -> None:
    """Soft-delete share links that expired BEYOND the retention window. Recently-expired links are
    left alone so owners can still re-enable them (expiry is already 410-enforced at read time);
    once aged past the window they flow into the normal purge. Mutates db; does NOT commit."""
    days = _retention_days()
    if days <= 0:
        return
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    links = db.query(ShareLink).filter(
        ShareLink.deleted_at.is_(None),
        ShareLink.expires_at.isnot(None),
        ShareLink.expires_at < cutoff,
    ).all()
    now = datetime.now(timezone.utc)
    for link in links:
        link.deleted_at = now
        counts.share_links_expired += 1
    if links:
        log.info("cleanup: soft-deleted %d long-expired share link(s)", len(links))


def _lock_if_still_purgeable(db, model, obj_id, cutoff):
    """Re-fetch a root row under SELECT ... FOR UPDATE, re-checking it is still soft-deleted and
    aged past the cutoff. Returns the locked row, or None if it was restored (deleted_at cleared),
    is no longer aged, or is already gone — in which case the caller must skip it. This closes the
    purge-vs-restore TOCTOU: a restore that commits before this runs is filtered out; a restore
    in-flight blocks on the lock and is then seen as deleted_at IS NULL; a restore after this locks
    the row blocks until the purge deletes+commits (the restore then no-ops)."""
    return db.query(model).filter(
        model.id == obj_id,
        model.deleted_at.isnot(None),
        model.deleted_at < cutoff,
    ).with_for_update().first()


def _purge_soft_deleted(db, counts: PurgeCounts) -> None:
    """Hard-delete every root soft-deleted longer than the retention window, cascading its subtree.
    Roots are processed top-down so a parent removes its children before a later pass queries them;
    each pass re-queries the DB, and every helper guards against a row already removed. Each root is
    re-checked+locked (`_lock_if_still_purgeable`) right before cascading, so a restore that races
    the scan can never be purged (see #107)."""
    days = _retention_days()
    if days <= 0:
        # 0/negative DISABLES the purge — guard BEFORE computing a cutoff so a misconfigured 0
        # can never make cutoff == now() and hard-delete every soft-deleted row.
        log.info("cleanup: disabled (soft_delete_retention_days=%s)", days)
        return
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    for model, purge in (
        (Project, _purge_project),
        (Folder, _purge_folder),
        (Asset, _purge_asset),
        (AssetVersion, _purge_version),
        (Comment, _purge_comment),
        (ShareLink, _purge_share_link),
    ):
        ids = [r.id for r in db.query(model.id).filter(
            model.deleted_at.isnot(None), model.deleted_at < cutoff,
        ).all()]
        for obj_id in ids:
            if _lock_if_still_purgeable(db, model, obj_id, cutoff) is None:
                continue  # restored or already removed since the scan
            purge(db, obj_id, counts)

    db.query(Approval).filter(Approval.deleted_at.isnot(None), Approval.deleted_at < cutoff).delete(synchronize_session=False)
    db.query(AssetShare).filter(AssetShare.deleted_at.isnot(None), AssetShare.deleted_at < cutoff).delete(synchronize_session=False)
    db.flush()


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


def _run_cleanup(db) -> PurgeCounts:
    """Full cleanup pass: expire long-dead share links, then hard-delete aged soft-deletes.
    Mutates db; the caller (task wrapper or admin endpoint) owns the commit. Guarded by a
    Postgres advisory xact lock so an overlapping purge (daily beat racing a manual
    `/admin/purge` enqueue) is skipped rather than double-cascading (see #107)."""
    days = _retention_days()
    counts = PurgeCounts(retention_days=days)  # report the clamped window actually used
    if days <= 0:
        return counts  # disabled; skip the advisory lock and all work
    got_lock = db.execute(text("SELECT pg_try_advisory_xact_lock(:k)"), {"k": _PURGE_ADVISORY_LOCK_KEY}).scalar()
    if not got_lock:
        log.info("cleanup: another purge holds the advisory lock; skipping this run")
        return counts
    _expire_share_links(db, counts)
    _purge_soft_deleted(db, counts)
    return counts


@celery_app.task(name="cleanup_soft_deleted")
def cleanup_soft_deleted():
    """Daily beat task: retention-window GC + expired-share sweep."""
    db = SessionLocal()
    try:
        counts = _run_cleanup(db)
        db.commit()
        log.info("cleanup: %s", asdict(counts))
        return asdict(counts)
    finally:
        db.close()


_ORPHAN_SWEEP_PREFIXES = ("raw/", "processed/")


@dataclass
class OrphanSweepCounts:
    grace_hours: int = 0
    delete_enabled: bool = False
    scanned: int = 0
    orphans: int = 0
    orphan_bytes: int = 0
    deleted: int = 0


def _sweep_orphan_s3(db) -> OrphanSweepCounts:
    """Report (and optionally delete) S3 keys under raw/ and processed/ that no MediaFile row owns.
    Report-only unless orphan_sweep_delete is True. Only keys older than orphan_sweep_grace_hours
    (0 disables) are considered. Read-only on the DB (no commit). A key is LIVE if it is a
    MediaFile.s3_key_raw / s3_key_thumbnail, or lives under processed/{project_id}/{asset_id}/{version_id}/
    (= the transcode output_prefix) for some MediaFile — derived from the raw key
    `raw/{project_id}/{asset_id}/{version_id}/...`. MediaFile is queried UNFILTERED on purpose: a
    soft-deleted-but-not-yet-purged asset still owns its S3 and belongs to the retention GC, not here."""
    grace = settings.orphan_sweep_grace_hours
    counts = OrphanSweepCounts(grace_hours=grace, delete_enabled=settings.orphan_sweep_delete)
    if grace <= 0:
        log.info("orphan-sweep: disabled (orphan_sweep_grace_hours=%s)", grace)
        return counts
    cutoff = datetime.now(timezone.utc) - timedelta(hours=grace)

    exact_live: set = set()
    processed_roots: set = set()
    for raw, thumb in db.query(MediaFile.s3_key_raw, MediaFile.s3_key_thumbnail).all():
        if raw:
            exact_live.add(raw)
            parts = raw.split("/")  # raw/{project_id}/{asset_id}/{version_id}/original.ext
            if len(parts) >= 4 and parts[0] == "raw":
                processed_roots.add("processed/" + "/".join(parts[1:4]) + "/")
        if thumb:
            exact_live.add(thumb)

    def _is_live(key):
        return key in exact_live or any(key.startswith(root) for root in processed_roots)

    orphans = []
    for prefix in _ORPHAN_SWEEP_PREFIXES:
        for key, last_modified, size in list_keys(prefix):
            counts.scanned += 1
            if last_modified >= cutoff:
                continue  # too recent — may be an in-flight / just-committed upload
            if _is_live(key):
                continue
            orphans.append((key, size))

    counts.orphans = len(orphans)
    counts.orphan_bytes = sum(s for _, s in orphans)

    # Safety floor: a degenerate (empty) live-set — e.g. DATABASE_URL pointed at the wrong/empty DB —
    # must never be allowed to mass-delete every scanned key as "orphaned". Report-only in that case.
    live_set_empty = not exact_live and not processed_roots
    if counts.delete_enabled and live_set_empty and orphans:
        log.error("orphan-sweep: SAFETY ABORT — live-set is EMPTY (0 MediaFile rows) but %d key(s) scanned; "
                  "refusing to delete (likely a wrong/empty DATABASE_URL). Reporting only.", counts.orphans)
    if counts.delete_enabled and not (live_set_empty and orphans):
        for key, _ in orphans:
            _safe(delete_object, key)
            counts.deleted += 1
        log.info("orphan-sweep: deleted %d/%d orphan key(s), %d bytes", counts.deleted, counts.orphans, counts.orphan_bytes)
    else:
        log.info("orphan-sweep: REPORT-ONLY — %d orphan key(s) under %s, %d bytes "
                 "(set ORPHAN_SWEEP_DELETE=true to reclaim). sample=%s",
                 counts.orphans, list(_ORPHAN_SWEEP_PREFIXES), counts.orphan_bytes, [k for k, _ in orphans[:10]])
    return counts


@celery_app.task(name="sweep_orphan_s3")
def sweep_orphan_s3():
    """Periodic beat task: report (or delete) orphaned S3 objects. Off until ORPHAN_SWEEP_GRACE_HOURS>0."""
    db = SessionLocal()
    try:
        return asdict(_sweep_orphan_s3(db))
    finally:
        db.close()
