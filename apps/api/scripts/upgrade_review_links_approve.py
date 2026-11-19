"""Let the review link of every open request approve (permission comment -> approve).

New requests already get an `approve` review link; this upgrades the ones created before.
Only links that are some open (not completed, not revoked) request's review link, are
currently `comment`, and whose request saw activity in the last 14 days (created, or a version
uploaded into its folder) change. Older ones keep `comment`. Re-running is safe (nothing left to upgrade -> 0).

Usage (inside the api container):
    python -m apps.api.scripts.upgrade_review_links_approve         # dry run: prints the count, writes nothing
    python -m apps.api.scripts.upgrade_review_links_approve --go    # writes
"""
import sys, os
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from sqlalchemy import or_

from apps.api.models.asset import Asset, AssetVersion
from apps.api.models.share import ShareLink, SharePermission
from apps.api.models.upload_request import UploadRequest


def run(db, go: bool = False, days: int = 14) -> int:
    """Number of review links that are (dry run) or were (go) upgraded."""
    cut = datetime.now(timezone.utc) - timedelta(days=days)
    recent_upload = (
        db.query(AssetVersion.id).join(Asset, Asset.id == AssetVersion.asset_id)
        .filter(Asset.folder_id == UploadRequest.folder_id, AssetVersion.created_at >= cut).exists()
    )
    links = (
        db.query(ShareLink)
        .join(UploadRequest, UploadRequest.review_share_token == ShareLink.token)
        .filter(UploadRequest.completed_at.is_(None), UploadRequest.revoked_at.is_(None),
                ShareLink.permission == SharePermission.comment, ShareLink.deleted_at.is_(None),
                or_(UploadRequest.created_at >= cut, recent_upload))
        .all()
    )
    if go:
        for link in links:
            link.permission = SharePermission.approve
        db.commit()
    return len(links)


if __name__ == "__main__":
    from apps.api.database import SessionLocal
    go = "--go" in sys.argv
    with SessionLocal() as session:
        n = run(session, go)
    print(f"{n} review link(s) {'upgraded to approve' if go else 'would be upgraded (open, active in the last 14 days; dry run, pass --go to write)'}")
