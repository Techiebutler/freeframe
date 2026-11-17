"""Numbering for asset versions, and which version stands for an asset.

Lives here rather than in a router because there are two handlers that create
versions, `upload.initiate_upload` and `assets.initiate_new_version`, and they
are near-verbatim copies of one another. Numbering that drifts between them
hands out different answers for the same asset depending on which route the
client happened to take. The same goes for "the latest version", which the
grid, the player, share links, comments and downloads all ask for:
`current_version` answers it for all of them.
"""
import uuid

from sqlalchemy import case, func, select, update
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


def current_version(
    db: Session, asset_id: uuid.UUID, *where, follow_pin: bool = True,
) -> AssetVersion | None:
    """The live version that stands for the asset, among those matching `where`.

    That is the version an editor set as current (`Asset.current_version_id`)
    when it is live and matches, and otherwise the highest-numbered one. Callers
    pass the statuses they can use: a share link or a stream wants `ready`, a
    listing also shows `processing`. `follow_pin=False` answers the default
    alone, which is what setting a version as current compares against.

    One query: the pinned row, if it qualifies, sorts first.
    """
    order = [AssetVersion.version_number.desc()]
    if follow_pin:
        pinned = select(Asset.current_version_id).where(Asset.id == asset_id).scalar_subquery()
        order.insert(0, case((AssetVersion.id == pinned, 0), else_=1))
    return db.query(AssetVersion).filter(
        AssetVersion.asset_id == asset_id, AssetVersion.deleted_at.is_(None), *where,
    ).order_by(*order).first()


def newer_version_ready(db: Session, version: AssetVersion) -> None:
    """End a current-version setting that `version`, now ready, supersedes.

    A new upload takes over from a version set as current, once it can be
    watched: until then the set version stays, so a share link keeps showing it
    rather than falling back to whichever version is newest while the upload
    is still on its way. Only a version numbered above the set one ends it;
    versions become ready once, at the end of their first transcode.

    A version deleted while it transcoded ends nothing: the transcode still
    runs to the end and marks it ready, but it is in the trash, and the set
    version is still the one to show. Restoring it later does not end the
    setting either, as no restore does.

    Whether it is still live is asked in the UPDATE itself, not of `version`:
    the transcode holds that row from before the encode, and a delete the API
    commits while ffmpeg runs is not in it. The check on the object only
    saves the statement when the deletion is already known.
    """
    if version.deleted_at is not None:
        return
    older = select(AssetVersion.id).where(
        AssetVersion.asset_id == version.asset_id,
        AssetVersion.version_number < version.version_number,
    )
    still_live = select(AssetVersion.id).where(
        AssetVersion.id == version.id, AssetVersion.deleted_at.is_(None),
    ).exists()
    db.execute(
        update(Asset)
        .where(Asset.id == version.asset_id, Asset.current_version_id.in_(older), still_live)
        .values(current_version_id=None)
    )
