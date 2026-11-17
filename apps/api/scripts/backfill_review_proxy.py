"""Add the 540p review proxy to the CURRENT version of every asset in an open request.

Playback keeps running from the existing ladder; each job only adds review_540.mp4 beside it.

Usage (inside the api container):
    python -m apps.api.scripts.backfill_review_proxy            # dry run: prints the count, queues nothing
    python -m apps.api.scripts.backfill_review_proxy --go       # enqueues on the 'transcoding' queue
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from sqlalchemy import func

from apps.api.database import SessionLocal
from apps.api.models.asset import Asset, AssetType, AssetVersion, ProcessingStatus
from apps.api.models.upload_request import UploadRequest
from apps.api.tasks.transcode_tasks import build_review_proxy


def current_versions(db):
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
        )
        .all()
    )
    return [(str(a), str(v)) for a, v in rows]


if __name__ == "__main__":
    db = SessionLocal()
    try:
        todo = current_versions(db)
    finally:
        db.close()
    print(f"{len(todo)} current versions in open requests.")
    if "--go" not in sys.argv:
        print("Dry run. Add --go to enqueue.")
    else:
        for a, v in todo:
            build_review_proxy.delay(a, v)
        print("Enqueued on the 'transcoding' queue.")
