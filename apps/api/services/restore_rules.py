"""One rule for taking an asset or a version back out of the trash.

Two doors reach the same rows: a project editor's `POST /assets/{id}/restore`
and the admin panel's `POST /admin/trash/restore`. They used to clear
`deleted_at` in two different ways, and the difference destroyed data. The
panel's version cleared the column alone, so an asset whose folder was in the
trash came back as a live row naming a trashed folder: the grid does not list
it, the project's trash does not list it, and the retention collector
hard-deleted it, with its objects, when it cascaded the folder. The panel's own
response said it had been restored.

So everything about *how* something comes back lives here, once, and both doors
call it:

* An asset whose folder is in the trash is moved to the project's root, which
  is the one place it is reachable from. (`restore_folder` is the other way
  round: restoring the folder brings its own assets back into it.)
* Nothing that was never usable work comes back at all. A discarded upload is
  soft-deleted by `_strip_asset_with_no_versions`, and `_dispose_version_files`
  deletes its objects *before* stamping the row, so restoring it would bring
  back a card that cannot be opened, streamed or given a version.

Neither door decides anything else here: who may restore, whether the project
is live and whether the retention window still allows it stay with the
endpoints, because those answers differ between a member and a superadmin.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models.asset import Asset, AssetVersion, ProcessingStatus
from ..models.folder import Folder

#: How far a version must have got for its row to be worth restoring.
#:
#: `failed` counts. The question is how far the version ever got, not where it
#: stopped: a failed transcode got as far as being dispatched, the bytes landed,
#: the asset carries a red Failed badge in the grid, and deleting it is someone
#: deleting their own work. `uploading` is the one status this excludes, and it
#: is the one the discard helpers were written for.
RESTORABLE_STATUSES = (
    ProcessingStatus.processing,
    ProcessingStatus.ready,
    ProcessingStatus.failed,
)


def was_ever_usable():
    """Whether an asset ever had a version that got as far as `processing`.

    A deleted asset that never did is not deleted work. It is an upload that was
    discarded or reclaimed before it landed, soft-deleted by
    `_strip_asset_with_no_versions` so it stops showing in the grid. Listed in
    the trash it sits among the things people actually deleted, and restoring it
    brings back the card that helper exists to remove: one that cannot be
    opened, streamed or given a version.

    A version keeps its status when it is soft-deleted, so this still holds for
    an asset whose versions went into the trash with it.
    """
    return (
        select(AssetVersion.id)
        .where(
            AssetVersion.asset_id == Asset.id,
            AssetVersion.processing_status.in_(RESTORABLE_STATUSES),
        )
        .exists()
    )


def restore_asset_row(db: Session, asset_id: uuid.UUID) -> bool:
    """Clear one trashed asset's `deleted_at`, under the rule both doors share.

    Returns whether a row really came back. False means the rule left it in the
    trash: it is not there at all any more, or it is an upload that was never
    usable work. The caller reports that rather than claiming a restore, since
    "we restored it" over a row that is still deleted is the whole failure this
    module exists for.

    Mutates `db` without committing. The UPDATE is guarded on the row still
    carrying a `deleted_at`, so a restore racing the collector's locked cascade
    matches nothing instead of resurrecting a half-purged asset.
    """
    asset = (
        db.query(Asset.id, Asset.folder_id)
        .filter(Asset.id == asset_id, Asset.deleted_at.isnot(None), was_ever_usable())
        .first()
    )
    if asset is None:
        return False

    folder_id = asset.folder_id
    if folder_id is not None:
        live_folder = (
            db.query(Folder.id)
            .filter(Folder.id == folder_id, Folder.deleted_at.is_(None))
            .first()
        )
        if live_folder is None:
            # The folder is in the trash (`DELETE /folders/{id}` stamps both), or
            # already gone. Root is then the only place this asset can be
            # reached from, and leaving `folder_id` pointing at the folder is
            # what got it hard-deleted with it.
            folder_id = None

    return bool(
        db.query(Asset)
        .filter(Asset.id == asset_id, Asset.deleted_at.isnot(None))
        .update({"deleted_at": None, "folder_id": folder_id}, synchronize_session="fetch")
    )


def restore_version_row(db: Session, version_id: uuid.UUID) -> bool:
    """Clear one trashed version's `deleted_at`, under the same rule.

    A version has no folder to be stranded in, so only the second half applies:
    an `uploading` version in the trash was discarded or reclaimed, and
    `_dispose_version_files` removed its objects before it stamped the row.
    Returns whether a row really came back.
    """
    return bool(
        db.query(AssetVersion)
        .filter(
            AssetVersion.id == version_id,
            AssetVersion.deleted_at.isnot(None),
            AssetVersion.processing_status.in_(RESTORABLE_STATUSES),
        )
        .update({"deleted_at": None}, synchronize_session="fetch")
    )
