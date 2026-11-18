"""Add the 540p review proxy to the CURRENT version of every asset in an open request,
when that version is from the last 14 days (older requests are dead; their proxy is built on the next upload).

Playback keeps running from the existing ladder; each job only adds review_540.mp4 beside it.
Jobs go to the 'default' queue so new uploads on 'transcoding' never wait behind the backfill.
--go also re-queues versions stuck in 'processing' from the last 24 h (their job was purged).

Usage (inside the api container):
    python -m apps.api.scripts.backfill_review_proxy            # dry run: prints the count, queues nothing
    python -m apps.api.scripts.backfill_review_proxy --go       # enqueues on the 'default' queue
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from datetime import datetime, timedelta, timezone

from sqlalchemy import func

from apps.api.database import SessionLocal
from apps.api.models.asset import Asset, AssetType, AssetVersion, ProcessingStatus
from apps.api.models.upload_request import UploadRequest
from apps.api.tasks.transcode_tasks import build_review_proxy, process_asset


def current_versions(db, days=14):
    """(asset_id, version_id) of the newest ready version of each video in an open request's folder."""
    newest = (
        db.query(AssetVersion.asset_id, func.max(AssetVersion.version_number).label("n"))
        .filter(AssetVersion.deleted_at.is_(None), AssetVersion.processing_status == ProcessingStatus.ready)
        .group_by(AssetVersion.asset_id).subquery()
    )
    rows = (
        db.query(Asset.id, AssetVersion.id)
        .join(UploadRequest, UploadRequest.folder_id == Asset.folder_id)
        .join(newest, newest.c.asset_id == Asset.id)
        .join(AssetVersion, (AssetVersion.asset_id == Asset.id) & (AssetVersion.version_number == newest.c.n))
        .filter(
            UploadRequest.completed_at.is_(None), UploadRequest.revoked_at.is_(None),
            Asset.deleted_at.is_(None), Asset.asset_type == AssetType.video,
            AssetVersion.created_at >= datetime.now(timezone.utc) - timedelta(days=days),
        )
        .all()
    )
    return [(str(a), str(v)) for a, v in rows]


def stuck_versions(db, hours=24):
    """(asset_id, version_id) still 'processing' after a queue purge."""
    rows = (
        db.query(AssetVersion.asset_id, AssetVersion.id)
        .filter(
            AssetVersion.deleted_at.is_(None), AssetVersion.processing_status == ProcessingStatus.processing,
            AssetVersion.created_at >= datetime.now(timezone.utc) - timedelta(hours=hours),
        )
        .all()
    )
    return [(str(a), str(v)) for a, v in rows]


if __name__ == "__main__":
    db = SessionLocal()
    try:
        todo = current_versions(db)
        stuck = stuck_versions(db)
    finally:
        db.close()
    print(f"{len(todo)} current versions (last 14 days) in open requests, {len(stuck)} stuck in processing.")
    if "--go" not in sys.argv:
        print("Dry run. Add --go to enqueue.")
    else:
        # ponytail: a version that is genuinely mid-transcode gets processed twice; harmless, it overwrites the same files.
        for a, v in stuck:
            process_asset.delay(a, v)
        for a, v in todo:
            build_review_proxy.apply_async((a, v), queue="default")
        print("Enqueued: stuck on 'transcoding', proxies on 'default'.")
