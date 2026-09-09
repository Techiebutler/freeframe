"""Numbering for asset versions.

Lives here rather than in a router because there are two handlers that create
versions, `upload.initiate_upload` and `assets.initiate_new_version`, and they
are near-verbatim copies of one another. Numbering that drifts between them
hands out different answers for the same asset depending on which route the
client happened to take.
"""
import uuid

from sqlalchemy.orm import Session

from ..models.asset import AssetVersion


def next_version_number(db: Session, asset_id: uuid.UUID) -> int:
    """The next free version number for an asset.

    Counts **every** version the asset has ever had, including soft-deleted ones.
    `uq_asset_versions_asset_version` spans `(asset_id, version_number)` and has
    no view of `deleted_at`, so a soft-deleted version still owns its number;
    skipping it here would return a number the constraint is still holding and
    the insert would fail with an `IntegrityError` on every retry, permanently.

    That is not a rare state. `_reap_stale_uploads` soft-deletes a version whose
    transfer stopped, so an asset with a single reclaimed upload would refuse
    every new version from then on.

    Numbers are therefore monotonic and not reused, so they can skip: after a
    reclaimed v2, the next upload is v3. Nothing derives an index or a position
    from the number, and both the comment export and share URLs label by it, so
    a number meaning one thing for the life of an asset is the property worth
    having. It holds for as long as the row does: `_purge_soft_deleted` hard
    deletes a soft-deleted version after `SOFT_DELETE_RETENTION_DAYS`, and the
    number becomes free again then.
    """
    last_version = db.query(AssetVersion).filter(
        AssetVersion.asset_id == asset_id,
    ).order_by(AssetVersion.version_number.desc()).first()
    return (last_version.version_number + 1) if last_version else 1
