"""An approved asset is locked against new versions: the newest version carries an approval, so an upload that
would bury it needs `reopen: true` (the human asked for changes). The approval stays on the old version."""
import uuid
from typing import Optional

from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ..models.approval import Approval, ApprovalStatus
from ..models.asset import AssetVersion, ProcessingStatus


class AlreadyApproved(Exception):
    def __init__(self, asset_id: uuid.UUID, version_id: uuid.UUID):
        self.asset_id, self.version_id = asset_id, version_id


def newest_approved(db: Session, asset_id: uuid.UUID) -> Optional[AssetVersion]:
    """The newest (live, not failed) version of the asset when it has an active approval, else None."""
    newest = db.query(AssetVersion).filter(AssetVersion.asset_id == asset_id, AssetVersion.deleted_at.is_(None),
                                           AssetVersion.processing_status != ProcessingStatus.failed) \
        .order_by(AssetVersion.version_number.desc()).first()
    if newest is None:
        return None
    held = db.query(Approval).filter(Approval.version_id == newest.id, Approval.status == ApprovalStatus.approved,
                                     Approval.deleted_at.is_(None)).first()
    return newest if held else None


def guard(db: Session, asset_id: uuid.UUID, reopen: bool) -> None:
    """Call before creating a version of an existing asset."""
    if reopen:
        return
    locked = newest_approved(db, asset_id)
    if locked is not None:
        raise AlreadyApproved(asset_id, locked.id)


def handler(_request, exc: AlreadyApproved) -> JSONResponse:
    return JSONResponse(status_code=409, content={
        "error": "already_approved", "asset_id": str(exc.asset_id), "version_id": str(exc.version_id),
        "hint": "pass reopen=true to start a new version anyway"})
