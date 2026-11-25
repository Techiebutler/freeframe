import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.asset import Asset, AssetVersion
from ..models.approval import Approval
from ..models.project import ProjectRole
from ..schemas.approval import ApprovalCreate, ApprovalResponse
from ..schemas.verdict import VerdictResponse, VerdictSet
from ..services.permissions import require_asset_access, require_live_project, require_project_role
from ..services.verdicts import (
    Actor, clean_note, clear_verdict, list_verdicts, remove_verdict, set_verdict,
)

router = APIRouter(tags=["approvals"])


def _get_asset(db: Session, asset_id: uuid.UUID) -> Asset:
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


def _live_version(db: Session, asset: Asset, version_id: uuid.UUID) -> AssetVersion:
    """The version, or 404 unless it is a live version of this asset. A verdict is
    about one version, so an id from another asset, a deleted version or an unknown
    one all read the same."""
    version = db.query(AssetVersion).filter(
        AssetVersion.id == version_id,
        AssetVersion.asset_id == asset.id,
        AssetVersion.deleted_at.is_(None),
    ).first()
    if version is None:
        raise HTTPException(status_code=404, detail="Version not found")
    return version


def _give(
    db: Session,
    asset_id: uuid.UUID,
    version_id: uuid.UUID,
    user: User,
    verdict: str,
    note: Optional[str],
) -> tuple[Asset, Approval]:
    """The one path a signed-in team member gives a verdict by, shared by the new PUT
    route and the legacy approve and reject routes."""
    asset = _get_asset(db, asset_id)
    # reviewer or above can give a verdict
    require_project_role(db, asset.project_id, user, ProjectRole.reviewer)
    version = _live_version(db, asset, version_id)
    approval = set_verdict(db, asset, version, Actor(user=user), verdict, clean_note(note))
    return asset, approval


@router.put("/assets/{asset_id}/verdict", response_model=VerdictResponse)
def put_verdict(
    asset_id: uuid.UUID,
    body: VerdictSet,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Give, or change, the caller's verdict on one version."""
    asset, approval = _give(db, asset_id, body.version_id, current_user, body.status, body.note)
    # The service committed, so read the verdict back the way every reader sees it.
    me = Actor(user=current_user)
    given = next((v for v in list_verdicts(db, asset, approval.version_id, me=me)
                  if v.id == approval.id), None)
    if given is None:
        # Cleared by someone else between the write and this read.
        raise HTTPException(status_code=404, detail="Verdict not found")
    return given


@router.delete("/assets/{asset_id}/verdict", status_code=status.HTTP_204_NO_CONTENT)
def clear_my_verdict(
    asset_id: uuid.UUID,
    version_id: uuid.UUID = Query(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Withdraw the caller's own verdict on one version. 204 even when there was none."""
    asset = _get_asset(db, asset_id)
    require_project_role(db, asset.project_id, current_user, ProjectRole.reviewer)
    version = _live_version(db, asset, version_id)
    clear_verdict(db, asset, version, Actor(user=current_user))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/assets/{asset_id}/verdicts/{verdict_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_someones_verdict(
    asset_id: uuid.UUID,
    verdict_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """An owner or editor deletes anyone's verdict on the asset, a guest's included."""
    asset = _get_asset(db, asset_id)
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)
    remove_verdict(db, asset, verdict_id, current_user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/assets/{asset_id}/verdicts", response_model=list[VerdictResponse])
def get_verdicts(
    asset_id: uuid.UUID,
    version_id: uuid.UUID = Query(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Every verdict on one version. Names and notes only, never an email: a viewer can read it."""
    asset = _get_asset(db, asset_id)
    # A deleted project is gone for everyone who was in it, so say so (404) ahead of
    # the access check, which would answer 403.
    require_live_project(db, asset.project_id)
    require_asset_access(db, asset, current_user)
    version = _live_version(db, asset, version_id)
    return list_verdicts(db, asset, version.id, me=Actor(user=current_user))


# ── Legacy routes, kept for existing clients ──────────────────────────────────

@router.post("/assets/{asset_id}/approve", response_model=ApprovalResponse)
def approve_asset(
    asset_id: uuid.UUID,
    body: ApprovalCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _, approval = _give(db, asset_id, body.version_id, current_user, "approved", body.note)
    return approval


@router.post("/assets/{asset_id}/reject", response_model=ApprovalResponse)
def reject_asset(
    asset_id: uuid.UUID,
    body: ApprovalCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _, approval = _give(db, asset_id, body.version_id, current_user, "rejected", body.note)
    return approval


@router.get("/assets/{asset_id}/approvals", response_model=list[ApprovalResponse])
def list_approvals(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = _get_asset(db, asset_id)
    require_asset_access(db, asset, current_user)
    # Approvals of a version deleted on its own are kept for a restore, and left
    # out here until then, as its comments are.
    return db.query(Approval).join(AssetVersion, Approval.version_id == AssetVersion.id).filter(
        Approval.asset_id == asset_id,
        Approval.deleted_at.is_(None),
        AssetVersion.deleted_at.is_(None),
    ).all()
