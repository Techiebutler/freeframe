"""Numbering for asset versions.

Lives here rather than in a router because there are two handlers that create
versions, `upload.initiate_upload` and `assets.initiate_new_version`, and they
are near-verbatim copies of one another. Numbering that drifts between them
hands out different answers for the same asset depending on which route the
client happened to take.
"""
import uuid

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..models.asset import Asset, AssetVersion


def next_version_number(db: Session, asset_id: uuid.UUID) -> int:
    """Take the next version number for an asset, and burn it.

    Numbers come from `Asset.last_version_number`, a counter that only goes up,
    not from the version rows. Counting the rows freed a number as soon as the
    retention purge hard-deleted its version, whenever that version was the
    highest one, because the next number was max plus one. With versions
    deletable one at a time that would make "v2" in an exported marker list or a
    share URL name a different cut a month later. Both the comment export and
    share URLs label by the number, so a number meaning one thing for the life of
    an asset is the property worth having, and the counter keeps it after the
    row is gone.

    Numbers are therefore monotonic and never reused, so they can skip: after a
    deleted or reclaimed v2, the next upload is v3.

    The counter is raised to at least the highest number any version row of the
    asset holds, soft-deleted ones included, before it is incremented.
    `uq_asset_versions_asset_version` spans `(asset_id, version_number)` with no
    view of `deleted_at`, so a number below a row that bypassed the counter
    would fail the insert with an `IntegrityError` on every retry, permanently.
    Both handlers go through here, so in practice the counter is already ahead.

    One atomic `UPDATE ... RETURNING`: it row-locks the asset until the caller
    commits, so two uploads racing on one asset are handed different numbers
    instead of the second dying on the unique constraint. Must be called inside
    the transaction that inserts the version.
    """
    highest_row = (
        select(func.coalesce(func.max(AssetVersion.version_number), 0))
        .where(AssetVersion.asset_id == asset_id)
        .scalar_subquery()
    )
    return db.execute(
        update(Asset)
        .where(Asset.id == asset_id)
        .values(last_version_number=func.greatest(Asset.last_version_number, highest_row) + 1)
        .returning(Asset.last_version_number)
    ).scalar_one()
