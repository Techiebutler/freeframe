import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.asset import Asset
from ..models.folder import Folder
from ..models.project import Project, ProjectRole
from ..models.user import User
from ..schemas.folder import (
    AssetMoveRequest,
    BulkMoveRequest,
    FolderCreate,
    FolderResponse,
    FolderTreeNode,
    FolderUpdate,
)
from ..services.permissions import require_project_role, get_project_member, is_public_project

router = APIRouter(tags=["folders"])

MAX_FOLDER_DEPTH = 10


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _get_folder(db: Session, folder_id: uuid.UUID) -> Folder:
    folder = (
        db.query(Folder)
        .filter(Folder.id == folder_id, Folder.deleted_at.is_(None))
        .first()
    )
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    return folder



def _get_descendant_ids(db: Session, folder_id: uuid.UUID) -> list[uuid.UUID]:
    """Get all descendant folder IDs (BFS)."""
    descendants: list[uuid.UUID] = []
    queue = [folder_id]
    while queue:
        current = queue.pop(0)
        children = (
            db.query(Folder.id)
            .filter(Folder.parent_id == current, Folder.deleted_at.is_(None))
            .all()
        )
        for (child_id,) in children:
            descendants.append(child_id)
            queue.append(child_id)
    return descendants


def _get_depth(db: Session, folder_id: Optional[uuid.UUID]) -> int:
    """Count depth from root to folder_id."""
    depth = 0
    current_id = folder_id
    while current_id:
        depth += 1
        folder = db.query(Folder).filter(Folder.id == current_id).first()
        if not folder:
            break
        current_id = folder.parent_id
    return depth


def _compute_item_count(db: Session, folder_id: uuid.UUID) -> int:
    """Count immediate subfolders + assets in a folder."""
    subfolder_count = (
        db.query(func.count(Folder.id))
        .filter(Folder.parent_id == folder_id, Folder.deleted_at.is_(None))
        .scalar()
        or 0
    )
    asset_count = (
        db.query(func.count(Asset.id))
        .filter(Asset.folder_id == folder_id, Asset.deleted_at.is_(None))
        .scalar()
        or 0
    )
    return subfolder_count + asset_count


def _folder_to_response(db: Session, folder: Folder) -> FolderResponse:
    resp = FolderResponse.model_validate(folder)
    resp.item_count = _compute_item_count(db, folder.id)
    return resp


def _get_descendant_ids_including_deleted(db: Session, folder_id: uuid.UUID) -> list[uuid.UUID]:
    """Get all descendant folder IDs including soft-deleted ones."""
    descendants: list[uuid.UUID] = []
    queue = [folder_id]
    while queue:
        current = queue.pop(0)
        children = db.query(Folder.id).filter(Folder.parent_id == current).all()
        for (child_id,) in children:
            if child_id not in descendants:
                descendants.append(child_id)
                queue.append(child_id)
    return descendants


def _max_subtree_depth(db: Session, folder_id: uuid.UUID) -> int:
    """Get the max depth of the subtree rooted at folder_id."""
    max_depth = 0
    queue: list[tuple[uuid.UUID, int]] = [(folder_id, 0)]
    while queue:
        current, depth = queue.pop(0)
        children = (
            db.query(Folder.id)
            .filter(Folder.parent_id == current, Folder.deleted_at.is_(None))
            .all()
        )
        for (child_id,) in children:
            child_depth = depth + 1
            if child_depth > max_depth:
                max_depth = child_depth
            queue.append((child_id, child_depth))
    return max_depth


# ─── CRUD ─────────────────────────────────────────────────────────────────────


@router.post(
    "/projects/{project_id}/folders",
    response_model=FolderResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_folder(
    project_id: uuid.UUID,
    body: FolderCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)

    # Validate parent exists and belongs to project
    if body.parent_id:
        parent = _get_folder(db, body.parent_id)
        if parent.project_id != project_id:
            raise HTTPException(status_code=400, detail="Parent folder not in this project")
        # Check depth
        depth = _get_depth(db, body.parent_id)
        if depth >= MAX_FOLDER_DEPTH:
            raise HTTPException(
                status_code=400,
                detail=f"Maximum folder depth of {MAX_FOLDER_DEPTH} exceeded",
            )

    folder = Folder(
        project_id=project_id,
        parent_id=body.parent_id,
        name=body.name,
        created_by=current_user.id,
    )
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return _folder_to_response(db, folder)


@router.get("/projects/{project_id}/folders", response_model=list[FolderResponse])
def list_folders(
    project_id: uuid.UUID,
    parent_id: Optional[str] = Query(None, description="Filter by parent_id. 'root' for root level."),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Allow access if user is a project member OR the project is public
    member = get_project_member(db, project_id, current_user.id)
    if not member and not is_public_project(db, project_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a project member")

    query = db.query(Folder).filter(
        Folder.project_id == project_id,
        Folder.deleted_at.is_(None),
    )

    if parent_id == "root":
        query = query.filter(Folder.parent_id.is_(None))
    elif parent_id is not None:
        query = query.filter(Folder.parent_id == uuid.UUID(parent_id))

    folders = query.order_by(Folder.created_at.desc()).all()
    return [_folder_to_response(db, f) for f in folders]


@router.get("/projects/{project_id}/folder-tree", response_model=list[FolderTreeNode])
def get_folder_tree(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Allow access if user is a project member OR the project is public
    member = get_project_member(db, project_id, current_user.id)
    if not member and not is_public_project(db, project_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a project member")

    all_folders = (
        db.query(Folder)
        .filter(Folder.project_id == project_id, Folder.deleted_at.is_(None))
        .all()
    )

    # Batch-compute item counts (avoid N+1 queries)
    folder_ids = [f.id for f in all_folders]

    subfolder_counts = dict(
        db.query(Folder.parent_id, func.count(Folder.id))
        .filter(Folder.parent_id.in_(folder_ids), Folder.deleted_at.is_(None))
        .group_by(Folder.parent_id)
        .all()
    ) if folder_ids else {}

    asset_counts = dict(
        db.query(Asset.folder_id, func.count(Asset.id))
        .filter(Asset.folder_id.in_(folder_ids), Asset.deleted_at.is_(None))
        .group_by(Asset.folder_id)
        .all()
    ) if folder_ids else {}

    # Build tree in Python
    folder_map: dict[uuid.UUID, FolderTreeNode] = {}
    for f in all_folders:
        folder_map[f.id] = FolderTreeNode(
            id=f.id,
            name=f.name,
            parent_id=f.parent_id,
            item_count=(subfolder_counts.get(f.id, 0) + asset_counts.get(f.id, 0)),
        )

    roots: list[FolderTreeNode] = []
    for node in folder_map.values():
        if node.parent_id and node.parent_id in folder_map:
            folder_map[node.parent_id].children.append(node)
        else:
            roots.append(node)

    return roots


@router.patch("/folders/{folder_id}", response_model=FolderResponse)
def update_folder(
    folder_id: uuid.UUID,
    body: FolderUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    folder = _get_folder(db, folder_id)
    require_project_role(db, folder.project_id, current_user, ProjectRole.editor)

    if body.name is not None:
        folder.name = body.name

    # Handle parent_id move (only if explicitly set)
    if "parent_id" in body.model_fields_set:
        new_parent_id = body.parent_id
        if new_parent_id is not None:
            # Can't move into self or descendant
            descendants = _get_descendant_ids(db, folder_id)
            if new_parent_id == folder_id or new_parent_id in descendants:
                raise HTTPException(status_code=400, detail="Cannot move folder into itself or a subfolder")
            parent = _get_folder(db, new_parent_id)
            if parent.project_id != folder.project_id:
                raise HTTPException(status_code=400, detail="Target folder not in same project")
            # Check depth
            depth = _get_depth(db, new_parent_id)
            max_subtree = _max_subtree_depth(db, folder_id)
            if depth + max_subtree + 1 > MAX_FOLDER_DEPTH:
                raise HTTPException(
                    status_code=400,
                    detail=f"Move would exceed maximum folder depth of {MAX_FOLDER_DEPTH}",
                )
        folder.parent_id = new_parent_id

    db.commit()
    db.refresh(folder)
    return _folder_to_response(db, folder)


@router.delete("/folders/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_folder(
    folder_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    folder = _get_folder(db, folder_id)
    require_project_role(db, folder.project_id, current_user, ProjectRole.editor)

    now = datetime.now(timezone.utc)

    # Cascade soft-delete: folder + all descendants + their assets
    all_folder_ids = [folder_id] + _get_descendant_ids(db, folder_id)

    db.query(Folder).filter(Folder.id.in_(all_folder_ids)).update(
        {"deleted_at": now}, synchronize_session="fetch"
    )
    db.query(Asset).filter(Asset.folder_id.in_(all_folder_ids)).update(
        {"deleted_at": now}, synchronize_session="fetch"
    )

    db.commit()


# ─── Move ─────────────────────────────────────────────────────────────────────


@router.patch("/assets/{asset_id}/move", response_model=dict)
def move_asset(
    asset_id: uuid.UUID,
    body: AssetMoveRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    if body.folder_id is not None:
        target = _get_folder(db, body.folder_id)
        if target.project_id != asset.project_id:
            raise HTTPException(status_code=400, detail="Target folder not in same project")

    asset.folder_id = body.folder_id
    db.commit()
    return {"ok": True}


@router.post("/projects/{project_id}/bulk-move", response_model=dict)
def bulk_move(
    project_id: uuid.UUID,
    body: BulkMoveRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)

    # Validate target folder
    if body.target_folder_id is not None:
        target = _get_folder(db, body.target_folder_id)
        if target.project_id != project_id:
            raise HTTPException(status_code=400, detail="Target folder not in this project")

    # Move assets
    if body.asset_ids:
        assets = (
            db.query(Asset)
            .filter(
                Asset.id.in_(body.asset_ids),
                Asset.project_id == project_id,
                Asset.deleted_at.is_(None),
            )
            .all()
        )
        if len(assets) != len(body.asset_ids):
            raise HTTPException(status_code=400, detail="Some assets not found in this project")
        for a in assets:
            a.folder_id = body.target_folder_id

    # Move folders
    if body.folder_ids:
        descendants = set()
        if body.target_folder_id:
            descendants = set(_get_descendant_ids(db, body.target_folder_id))
            descendants.add(body.target_folder_id)

        folders = (
            db.query(Folder)
            .filter(
                Folder.id.in_(body.folder_ids),
                Folder.project_id == project_id,
                Folder.deleted_at.is_(None),
            )
            .all()
        )
        if len(folders) != len(body.folder_ids):
            raise HTTPException(status_code=400, detail="Some folders not found in this project")

        for f in folders:
            if f.id in descendants or f.id == body.target_folder_id:
                raise HTTPException(
                    status_code=400,
                    detail=f"Cannot move folder '{f.name}' into itself or a subfolder",
                )
            f.parent_id = body.target_folder_id

    db.commit()
    return {"ok": True, "moved_assets": len(body.asset_ids), "moved_folders": len(body.folder_ids)}


# ─── Trash & Restore ─────────────────────────────────────────────────────────


@router.get("/projects/{project_id}/trash", response_model=dict)
def list_trash(
    project_id: uuid.UUID,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)

    deleted_folders = (
        db.query(Folder)
        .filter(Folder.project_id == project_id, Folder.deleted_at.isnot(None))
        .order_by(Folder.deleted_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )

    deleted_assets = (
        db.query(Asset)
        .filter(Asset.project_id == project_id, Asset.deleted_at.isnot(None))
        .order_by(Asset.deleted_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )

    return {
        "folders": [
            {
                "id": str(f.id),
                "name": f.name,
                "type": "folder",
                "parent_id": str(f.parent_id) if f.parent_id else None,
                "deleted_at": f.deleted_at.isoformat() if f.deleted_at else None,
            }
            for f in deleted_folders
        ],
        "assets": [
            {
                "id": str(a.id),
                "name": a.name,
                "type": a.asset_type,
                "folder_id": str(a.folder_id) if a.folder_id else None,
                "deleted_at": a.deleted_at.isoformat() if a.deleted_at else None,
            }
            for a in deleted_assets
        ],
    }


@router.post("/assets/{asset_id}/restore", response_model=dict)
def restore_asset(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.isnot(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Deleted asset not found")

    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    # A deleted project has no restore path, so restoring an asset into a soft-deleted project would be
    # a false success — the retention GC's project cascade would silently hard-delete it. Refuse.
    project = db.query(Project).filter(Project.id == asset.project_id).first()
    if project is None or project.deleted_at is not None:
        raise HTTPException(status_code=409, detail="Cannot restore: the project has been deleted")

    # If parent folder is deleted, move to root
    if asset.folder_id:
        parent_folder = (
            db.query(Folder)
            .filter(Folder.id == asset.folder_id, Folder.deleted_at.is_(None))
            .first()
        )
        if not parent_folder:
            asset.folder_id = None

    asset.deleted_at = None
    db.commit()
    return {"ok": True}


@router.post("/folders/{folder_id}/restore", response_model=dict)
def restore_folder(
    folder_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    folder = db.query(Folder).filter(Folder.id == folder_id, Folder.deleted_at.isnot(None)).first()
    if not folder:
        raise HTTPException(status_code=404, detail="Deleted folder not found")

    require_project_role(db, folder.project_id, current_user, ProjectRole.editor)

    project = db.query(Project).filter(Project.id == folder.project_id).first()
    if project is None or project.deleted_at is not None:
        raise HTTPException(status_code=409, detail="Cannot restore: the project has been deleted")

    # If parent folder is deleted, restore to root
    if folder.parent_id:
        parent = (
            db.query(Folder)
            .filter(Folder.id == folder.parent_id, Folder.deleted_at.is_(None))
            .first()
        )
        if not parent:
            folder.parent_id = None

    # Restore folder and all its descendants + their assets
    folder.deleted_at = None
    descendant_ids = _get_descendant_ids_including_deleted(db, folder_id)
    all_ids = [folder_id] + descendant_ids

    db.query(Folder).filter(Folder.id.in_(all_ids)).update(
        {"deleted_at": None}, synchronize_session="fetch"
    )
    db.query(Asset).filter(Asset.folder_id.in_(all_ids), Asset.deleted_at.isnot(None)).update(
        {"deleted_at": None}, synchronize_session="fetch"
    )

    db.commit()
    return {"ok": True}
