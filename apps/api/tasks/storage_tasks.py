"""Storage bookkeeping tasks.

One task: fill in `media_files.derived_size_bytes` for rows written before the
column existed. The admin storage overview reads that column, so until this has
run those files are reported as unmeasured rather than as zero bytes.

Why a task and not a page-load query: measuring derived bytes means listing a
bucket prefix per version. On an instance with a few thousand versions that is a
few thousand round trips to S3, which belongs in the worker once, not in a
request handler every time somebody opens the admin panel.

Nothing schedules this task. It runs when `POST /admin/storage/backfill` is
called or when it is called by hand (see the upgrade notes in `CHANGELOG.md`),
which is deliberate: a measurement raises the figure the storage cap is enforced
against, so it happens when an administrator asks for it, not on a timer behind
their back.
"""
import logging
import sys
import os
import time

# Ensure the workspace root is on the path (as the other task modules do).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from sqlalchemy import text, tuple_, update

from .celery_app import celery_app
from ..database import SessionLocal, engine
from ..models.asset import Asset, AssetVersion, MediaFile
from ..services.storage import committed_media

log = logging.getLogger("celery.storage")

#: Rows per batch and per commit. Small enough that a worker restart loses
#: little work and that only this many rows are ever in memory at once, large
#: enough that the commit overhead stays under the S3 listing it is paying for.
BATCH_SIZE = 200

#: Seconds to wait between batches, so a backfill of a large instance does not
#: take the whole S3 request budget while people are working. One listing per
#: version is cheap; tens of thousands of them back to back are not.
BATCH_PAUSE_SECONDS = 0.5

#: Consecutive failed listings that end the run. A store that is down fails
#: every listing, and carrying on would spend one bounded request per remaining
#: row to learn the same thing; the rows stay NULL and a later run measures
#: them. Consecutive, not total: one prefix a store refuses must not stop a
#: backfill that is otherwise working.
MAX_CONSECUTIVE_LISTING_FAILURES = 5

#: Serializes the backfill against itself (pg advisory lock space). Every call
#: to the trigger enqueues a run, and two runs listing the same prefixes would
#: pay twice for the same answer. Session-scoped, not xact-scoped like the
#: retention purge: this task commits per batch, which would drop an xact lock
#: after the first one. Held on its own connection, see the task.
_BACKFILL_ADVISORY_LOCK_KEY = 5477652


def unmeasured_media_rows(db, limit: int | None = None, after: tuple | None = None):
    """Committed media whose derived bytes have never been measured, as
    `(MediaFile, project_id, asset_id, version_id)` tuples.

    The ids come along in the same query so building each output prefix costs no
    extra round trip.

    Built on `committed_media`, the one definition the figures use, so the rows
    this measures are exactly the rows the figures count. That includes media in
    the trash: a soft-deleted project, asset or version keeps its objects until
    it is purged, and the used figure counts them, so leaving them out left
    `unmeasured_files` above zero after a complete backfill and their derived
    bytes out of `used` and `trash_bytes` until the trash happened to purge. An
    `uploading` or `failed` version is still skipped, by `committed_media`
    itself: it has no transcode output to measure, and writing 0 would make it
    look measured forever.

    `after` is the `(created_at, id)` of the last row of the previous batch, for
    keyset paging. `created_at` alone is not unique, so the id breaks the tie;
    without it a batch boundary inside one timestamp would skip rows. Paging by
    the NULL filter alone would not terminate: a row whose listing failed stays
    NULL and would be handed out again forever.
    """
    q = committed_media(
        db, MediaFile, Asset.project_id, Asset.id, AssetVersion.id,
    ).filter(MediaFile.derived_size_bytes.is_(None))
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

    **It never overwrites a measurement.** The write is a conditional
    `UPDATE ... WHERE derived_size_bytes IS NULL`, so a transcode that finishes
    between this run's listing and this run's commit keeps its own figure, and
    a row purged mid-batch is a no-op rather than an error. `measured` counts
    the rows this run really wrote.

    **One run at a time.** Each call to the trigger enqueues a run; a
    Postgres advisory lock lets the first one proceed and makes the rest return
    immediately instead of paying for the same listings again. Between batches
    it pauses, so a long backfill leaves S3 request budget for the people
    working on the instance.

    **It gives up on a store that is down.** Listings use a bounded client, and
    `MAX_CONSECUTIVE_LISTING_FAILURES` of them in a row end the run with
    `stopped` in the result; the unmeasured rows stay NULL for a later run.

    A version whose prefix holds nothing is recorded as 0, not left NULL: 0 is
    the true answer for a version that never produced output (an old upload
    whose renditions the retention purge reclaimed), and leaving it NULL would
    make every later run list that prefix again.
    """
    from ..services.s3_service import prefix_size_bytes

    pause = BATCH_PAUSE_SECONDS if pause_seconds is None else pause_seconds
    db = SessionLocal()
    # The advisory lock lives on a connection of its own, taken for the whole
    # run and used for nothing else. A session-scoped lock belongs to the
    # Postgres backend that took it, while a pooled `Session` gives its
    # connection back on every commit, so this task's per-batch commits could
    # put the lock and the unlock on two different backends, and a failed flush
    # would poison the session and skip the unlock altogether. On a dedicated
    # connection neither can happen.
    lock_conn = engine.connect()
    measured = failed = 0
    total_bytes = 0
    got_lock = False
    stopped = None
    try:
        got_lock = bool(lock_conn.execute(
            text("SELECT pg_try_advisory_lock(:k)"),
            {"k": _BACKFILL_ADVISORY_LOCK_KEY},
        ).scalar())
        if not got_lock:
            log.info("backfill: another run holds the advisory lock; skipping this one")
            return {"measured": 0, "failed": 0, "bytes": 0, "skipped": True}
        remaining = limit
        after = None
        consecutive_failures = 0
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
                    consecutive_failures += 1
                    log.warning("backfill: could not list %s: %s", prefix, exc)
                    if consecutive_failures >= MAX_CONSECUTIVE_LISTING_FAILURES:
                        stopped = "listing_failures"
                        log.warning(
                            "backfill: %s listings failed in a row; stopping. The "
                            "unmeasured rows stay unmeasured; run it again once the "
                            "object store answers.",
                            consecutive_failures,
                        )
                        break
                    continue
                consecutive_failures = 0
                # Conditional on the row still being unmeasured, so a transcode
                # that finished since this batch was selected keeps its own
                # figure and a row purged mid-batch is a no-op.
                written = db.execute(
                    update(MediaFile)
                    .where(
                        MediaFile.id == media_file.id,
                        MediaFile.derived_size_bytes.is_(None),
                    )
                    .values(derived_size_bytes=prefix_bytes)
                ).rowcount
                if written:
                    measured += 1
                    total_bytes += prefix_bytes
            db.commit()
            if stopped:
                break
            if remaining is not None:
                remaining -= len(rows)
            if len(rows) < size:
                break
            del rows
            if pause:
                time.sleep(pause)
        db.commit()
        log.info(
            "backfill_media_derived_size: measured=%s failed=%s bytes=%s stopped=%s",
            measured, failed, total_bytes, stopped,
        )
        result: dict = {"measured": measured, "failed": failed, "bytes": total_bytes}
        if stopped:
            result["stopped"] = stopped
        return result
    finally:
        if got_lock:
            try:
                lock_conn.execute(
                    text("SELECT pg_advisory_unlock(:k)"),
                    {"k": _BACKFILL_ADVISORY_LOCK_KEY},
                )
            except Exception as exc:  # pragma: no cover - the connection is ours alone
                log.warning("backfill: could not release the advisory lock: %s", exc)
        lock_conn.close()
        db.close()
