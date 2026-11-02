"""Storage bookkeeping tasks.

One task: fill in `media_files.derived_size_bytes` for rows written before the
column existed. The admin storage overview reads that column, so until this has
run those files are reported as unmeasured rather than as zero bytes.

Why a task and not a page-load query: measuring derived bytes means listing a
bucket prefix per version. On an instance with a few thousand versions that is a
few thousand round trips to S3, which belongs in the worker once, not in a
request handler every time somebody opens the admin panel.
"""
import logging
import sys
import os
import time

# Ensure the workspace root is on the path (as the other task modules do).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from sqlalchemy import text, tuple_

from .celery_app import celery_app
from ..database import SessionLocal
from ..models.asset import Asset, AssetVersion, MediaFile, ProcessingStatus

log = logging.getLogger("celery.storage")

#: Rows per batch and per commit. Small enough that a worker restart loses
#: little work and that only this many rows are ever in memory at once, large
#: enough that the commit overhead stays under the S3 listing it is paying for.
BATCH_SIZE = 200

#: Seconds to wait between batches, so a backfill of a large instance does not
#: take the whole S3 request budget while people are working. One listing per
#: version is cheap; tens of thousands of them back to back are not.
BATCH_PAUSE_SECONDS = 0.5

#: Serializes the backfill against itself (pg advisory lock space). Every call
#: to the trigger enqueues a run, and two runs listing the same prefixes would
#: pay twice for the same answer. Session-scoped, not xact-scoped like the
#: retention purge: this task commits per batch, which would drop an xact lock
#: after the first one.
_BACKFILL_ADVISORY_LOCK_KEY = 5477652


def unmeasured_media_rows(db, limit: int | None = None, after: tuple | None = None):
    """Committed media whose derived bytes have never been measured, as
    `(MediaFile, project_id, asset_id, version_id)` tuples.

    The ids come along in the same query so building each output prefix costs no
    extra round trip.

    The same committed definition as `services.storage`: a live asset, a live
    version, `processing` or `ready`. An `uploading` or `failed` version is
    skipped on purpose — it has no transcode output to measure, and writing 0
    would make it look measured forever.

    `after` is the `(created_at, id)` of the last row of the previous batch, for
    keyset paging. `created_at` alone is not unique, so the id breaks the tie;
    without it a batch boundary inside one timestamp would skip rows. Paging by
    the NULL filter alone would not terminate: a row whose listing failed stays
    NULL and would be handed out again forever.
    """
    q = (
        db.query(MediaFile, Asset.project_id, Asset.id, AssetVersion.id)
        .join(AssetVersion, MediaFile.version_id == AssetVersion.id)
        .join(Asset, AssetVersion.asset_id == Asset.id)
        .filter(
            MediaFile.derived_size_bytes.is_(None),
            Asset.deleted_at.is_(None),
            AssetVersion.deleted_at.is_(None),
            AssetVersion.processing_status.in_(
                [ProcessingStatus.processing, ProcessingStatus.ready]
            ),
        )
    )
    if after is not None:
        q = q.filter(tuple_(MediaFile.created_at, MediaFile.id) > after)
    q = q.order_by(MediaFile.created_at, MediaFile.id)
    if limit is not None:
        q = q.limit(limit)
    return q.all()


def output_prefix_for(project_id, asset_id, version_id) -> str:
    """The prefix a transcode writes under, as `tasks.transcode_tasks` builds it.

    Derived from the ids rather than read from `s3_key_processed`, because that
    column holds the HLS prefix for video but a single object key for audio and
    stills, and only the version prefix covers the thumbnail and the MP4 as
    well.
    """
    return f"processed/{project_id}/{asset_id}/{version_id}"


@celery_app.task(bind=True, name="backfill_media_derived_size")
def backfill_media_derived_size(self, limit: int | None = None, pause_seconds: float | None = None):
    """Sum each unmeasured version's output prefix in S3 and store the total.

    Idempotent and resumable: it only ever touches rows where
    `derived_size_bytes IS NULL`, so a second run picks up where a killed first
    one stopped and a completed run finds nothing to do. Safe to run while the
    instance is serving.

    **In batches, never the whole table.** `BATCH_SIZE` rows are fetched,
    measured, committed and let go of before the next keyset page is asked for,
    so an instance with a hundred thousand unmeasured files costs the worker the
    same memory as one with two hundred. The session's identity map holds only
    weak references, and the batch's own list is the last strong one, so the
    committed rows are collectable as soon as the loop moves on.

    **One run at a time.** Each call to the trigger enqueues a run; a
    Postgres advisory lock lets the first one proceed and makes the rest return
    immediately instead of paying for the same listings again. Between batches
    it pauses, so a long backfill leaves S3 request budget for the people
    working on the instance.

    A version whose prefix holds nothing is recorded as 0, not left NULL: 0 is
    the true answer for a version that never produced output (an old upload
    whose renditions the retention purge reclaimed), and leaving it NULL would
    make every later run list that prefix again.
    """
    from ..services.s3_service import prefix_size_bytes

    pause = BATCH_PAUSE_SECONDS if pause_seconds is None else pause_seconds
    db = SessionLocal()
    measured = failed = 0
    total_bytes = 0
    try:
        got_lock = db.execute(
            text("SELECT pg_try_advisory_lock(:k)"),
            {"k": _BACKFILL_ADVISORY_LOCK_KEY},
        ).scalar()
        if not got_lock:
            log.info("backfill: another run holds the advisory lock; skipping this one")
            return {"measured": 0, "failed": 0, "bytes": 0, "skipped": True}
        try:
            remaining = limit
            after = None
            while remaining is None or remaining > 0:
                size = BATCH_SIZE if remaining is None else min(BATCH_SIZE, remaining)
                rows = unmeasured_media_rows(db, size, after)
                if not rows:
                    break
                for media_file, project_id, asset_id, version_id in rows:
                    # Read the keyset before the commit expires the row.
                    after = (media_file.created_at, media_file.id)
                    prefix = output_prefix_for(project_id, asset_id, version_id)
                    try:
                        prefix_bytes = prefix_size_bytes(prefix)
                    except Exception as exc:
                        failed += 1
                        log.warning("backfill: could not list %s: %s", prefix, exc)
                        continue
                    media_file.derived_size_bytes = prefix_bytes
                    measured += 1
                    total_bytes += prefix_bytes
                db.commit()
                if remaining is not None:
                    remaining -= len(rows)
                if len(rows) < size:
                    break
                del rows
                if pause:
                    time.sleep(pause)
            db.commit()
        finally:
            db.execute(
                text("SELECT pg_advisory_unlock(:k)"),
                {"k": _BACKFILL_ADVISORY_LOCK_KEY},
            )
            db.commit()
        log.info(
            "backfill_media_derived_size: measured=%s failed=%s bytes=%s",
            measured, failed, total_bytes,
        )
        return {"measured": measured, "failed": failed, "bytes": total_bytes}
    finally:
        db.close()
