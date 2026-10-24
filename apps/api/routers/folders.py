import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.asset import Asset, AssetVersion, ProcessingStatus
from ..models.folder import Folder
from ..models.project import Project, ProjectRole
from ..models.user import User
from ..schemas.folder import (
    AssetMoveRequest,
    BulkMoveRequest,
    EnsuredFolder,
    EnsureFoldersRequest,
    EnsureFoldersResponse,
    FolderCreate,
    FolderResponse,
    FolderTreeNode,
    FolderUpdate,
)
from ..services.folder_paths import (
    MAX_ENSURE_NODES,
    MAX_FOLDER_DEPTH,
    _get_depth,
    distinct_prefixes,
    ensure_folder_paths,
    lock_project_folders,
)
from ..services.permissions import (
    folder_chain_is_live,
    require_project_role,
    require_project_visible,
)

router = APIRouter(tags=["folders"])

# MAX_FOLDER_DEPTH and _get_depth live in services/folder_paths, shared with
# the folder-upload ensure service.


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


def _folder_name_conflict(name: Optional[str]) -> HTTPException:
    if name is None:
        return HTTPException(status_code=409, detail="A folder with that name already exists here")
    return HTTPException(status_code=409, detail=f"A folder named '{name}' already exists here")


def _ensure_folder_name_free(
    db: Session,
    project_id: uuid.UUID,
    parent_id: Optional[uuid.UUID],
    name: str,
    exclude_ids: tuple[uuid.UUID, ...] = (),
) -> None:
    """Refuse a second live folder of `name` under `parent_id`.

    `uq_folder_name_per_parent` allows one live folder per name and parent, and a
    trashed folder frees its name. Left to the index, the collision is a 500.
    Root level is exempt, as in the index: a NULL parent is never equal to another.
    """
    if parent_id is None:
        return
    query = db.query(Folder.id).filter(
        Folder.project_id == project_id,
        Folder.parent_id == parent_id,
        Folder.name == name,
        Folder.deleted_at.is_(None),
    )
    if exclude_ids:
        query = query.filter(Folder.id.notin_(exclude_ids))
    if query.first() is not None:
        raise _folder_name_conflict(name)


@contextmanager
def _folder_name_guard(db: Session, name: Optional[str]):
    """Turn the index's own refusal into the same 409, for a sibling a
    concurrent request created after `_ensure_folder_name_free` looked."""
    try:
        yield
    except IntegrityError as e:
        db.rollback()
        if "uq_folder_name_per_parent" not in str(e.orig):
            raise
        raise _folder_name_conflict(name) from e


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

    _ensure_folder_name_free(db, project_id, body.parent_id, body.name)

    folder = Folder(
        project_id=project_id,
        parent_id=body.parent_id,
        name=body.name,
        created_by=current_user.id,
    )
    db.add(folder)
    with _folder_name_guard(db, body.name):
        db.commit()
    db.refresh(folder)
    return _folder_to_response(db, folder)


@router.post("/projects/{project_id}/folders/ensure", response_model=EnsureFoldersResponse)
def ensure_folders(
    project_id: uuid.UUID,
    body: EnsureFoldersRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Find or create each folder path under `parent_id` (None: the project
    root), for a folder upload. Each segment reuses the live folder of that
    name under that parent, or is created, so uploading the same folder twice
    merges. Paths deeper than MAX_FOLDER_DEPTH allows, counted from the project
    root, are cut; a null folder_id means the parent itself.

    Editor or above. The parent must be a live folder of this project with no
    trashed folder above it.
    """
    require_project_role(db, project_id, current_user, ProjectRole.editor)

    paths = body.normalized_paths()
    if distinct_prefixes(paths) > MAX_ENSURE_NODES:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "too_many_folders",
                "message": (
                    f"This upload names more than {MAX_ENSURE_NODES} folders. "
                    "Upload fewer folders at a time."
                ),
            },
        )

    # Checked under the project lock that delete_folder also takes, so a delete
    # of the parent either finishes first and is seen here, or waits for this
    # transaction and then trashes the folders it made along with the rest.
    lock_project_folders(db, project_id)
    if body.parent_id is not None:
        parent = (
            db.query(Folder.id)
            .filter(
                Folder.id == body.parent_id,
                Folder.project_id == project_id,
                Folder.deleted_at.is_(None),
            )
            .first()
        )
        if parent is None or not folder_chain_is_live(db, body.parent_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": "folder_not_in_project",
                    "message": (
                        "The folder you are uploading into is no longer in this project. "
                        "Refresh the page and try again."
                    ),
                },
            )

    ensured = ensure_folder_paths(db, project_id, body.parent_id, paths, current_user.id)
    db.commit()

    return EnsureFoldersResponse(
        folders=[
            EnsuredFolder(path=sent, folder_id=ensured[normalized])
            for sent, normalized in zip(body.paths, paths)
        ]
    )


@router.get("/projects/{project_id}/folders", response_model=list[FolderResponse])
def list_folders(
    project_id: uuid.UUID,
    parent_id: Optional[str] = Query(None, description="Filter by parent_id. 'root' for root level."),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Allow access if user is a project member OR the project is public
    require_project_visible(db, project_id, current_user)

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
    require_project_visible(db, project_id, current_user)

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

    name = body.name if body.name is not None else folder.name
    parent_id = folder.parent_id

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
        parent_id = new_parent_id

    _ensure_folder_name_free(db, folder.project_id, parent_id, name, exclude_ids=(folder_id,))

    folder.name = name
    folder.parent_id = parent_id
    with _folder_name_guard(db, name):
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
    # Wait for any folder ensure in flight, so the descendants listed below
    # include the folders it is making inside this one.
    lock_project_folders(db, folder.project_id)

    now = datetime.now(timezone.utc)

    # Cascade soft-delete: folder + all descendants + their assets
    all_folder_ids = [folder_id] + _get_descendant_ids(db, folder_id)

    db.query(Folder).filter(
        Folder.id.in_(all_folder_ids), Folder.deleted_at.is_(None)
    ).update({"deleted_at": now}, synchronize_session="fetch")
    db.query(Asset).filter(
        Asset.folder_id.in_(all_folder_ids), Asset.deleted_at.is_(None)
    ).update({"deleted_at": now}, synchronize_session="fetch")

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
    # The name a collision at commit is reported under: unknown when several moved.
    moved_name: Optional[str] = None
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

        moving_ids = tuple(f.id for f in folders)
        moving_names: set[str] = set()
        for f in folders:
            if f.id in descendants or f.id == body.target_folder_id:
                raise HTTPException(
                    status_code=400,
                    detail=f"Cannot move folder '{f.name}' into itself or a subfolder",
                )
            if body.target_folder_id is not None and f.name in moving_names:
                raise _folder_name_conflict(f.name)
            moving_names.add(f.name)
            _ensure_folder_name_free(
                db, project_id, body.target_folder_id, f.name, exclude_ids=moving_ids,
            )
        for f in folders:
            f.parent_id = body.target_folder_id
        if len(folders) == 1:
            moved_name = folders[0].name

    with _folder_name_guard(db, moved_name):
        db.commit()
    return {"ok": True, "moved_assets": len(body.asset_ids), "moved_folders": len(body.folder_ids)}


# ─── Trash & Restore ─────────────────────────────────────────────────────────


def _was_ever_usable():
    """Whether an asset ever had a version that got as far as `processing`.

    A deleted asset that never did is not deleted work. It is an upload that was
    discarded or reclaimed before it landed, soft-deleted by
    `_strip_asset_with_no_versions` so it stops showing in the grid. Listed in
    the trash it sits among the things people actually deleted, and restoring it
    brings back the card that helper exists to remove: one that cannot be
    opened, streamed or given a version.

    `failed` counts. The question is how far the version ever got, not where it
    stopped, and a failed transcode got as far as being dispatched: the bytes
    landed, the asset carries a red Failed badge in the grid, and deleting it is
    someone deleting their own work. Leaving it out took a restorable asset out
    of the trash entirely and made restore answer 404. `uploading` is the one
    status this excludes, and it is the one the helper was written for.

    A version keeps its status when it is soft-deleted, so this still holds for
    an asset whose versions went into the trash with it.
    """
    return (
        select(AssetVersion.id)
        .where(
            AssetVersion.asset_id == Asset.id,
            AssetVersion.processing_status.in_(
                [ProcessingStatus.processing, ProcessingStatus.ready,
                 ProcessingStatus.failed]
            ),
        )
        .exists()
    )


def _can_restore_folder_asset():
    """Whether a folder cascade may restore usable work or a live upload."""
    has_live_version = (
        select(AssetVersion.id)
        .where(
            AssetVersion.asset_id == Asset.id,
            AssetVersion.deleted_at.is_(None),
        )
        .exists()
    )
    return or_(_was_ever_usable(), has_live_version)


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
        .filter(
            Asset.project_id == project_id,
            Asset.deleted_at.isnot(None),
            _was_ever_usable(),
        )
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
    asset = db.query(Asset).filter(
        Asset.id == asset_id, Asset.deleted_at.isnot(None), _was_ever_usable(),
    ).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Deleted asset not found")

    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    # A deleted project has no restore path, so restoring an asset into a soft-deleted project would be
    # a false success — the retention GC's project cascade would silently hard-delete it. Refuse.
    project = db.query(Project).filter(Project.id == asset.project_id).first()
    if project is None or project.deleted_at is not None:
        raise HTTPException(status_code=409, detail="Cannot restore: the project has been deleted")

    # If parent folder is deleted, move to root
    folder_id = asset.folder_id
    if folder_id:
        parent_folder = (
            db.query(Folder)
            .filter(Folder.id == folder_id, Folder.deleted_at.is_(None))
            .first()
        )
        if not parent_folder:
            folder_id = None

    # Guarded on the row still being in the trash. The retention purge may have locked and
    # hard-deleted it since it was read above; then nothing matches and the asset is gone.
    restored = db.query(Asset).filter(
        Asset.id == asset_id, Asset.deleted_at.isnot(None),
    ).update({"deleted_at": None, "folder_id": folder_id}, synchronize_session="fetch")
    if not restored:
        db.rollback()
        raise HTTPException(status_code=404, detail="Deleted asset not found")
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
    parent_id = folder.parent_id
    if parent_id:
        parent = (
            db.query(Folder)
            .filter(Folder.id == parent_id, Folder.deleted_at.is_(None))
            .first()
        )
        if not parent:
            parent_id = None

    # Its name may have been taken while it was in the trash.
    _ensure_folder_name_free(db, folder.project_id, parent_id, folder.name)

    # Keep the cascade timestamp as the marker for which descendants this restore owns.
    # Rows already in the trash have an earlier timestamp and must remain there.
    restore_timestamp = folder.deleted_at
    with _folder_name_guard(db, folder.name):
        # Guarded like restore_asset: the retention purge may have hard-deleted the folder since
        # it was read above, and then there is nothing left to restore.
        restored = db.query(Folder).filter(
            Folder.id == folder_id, Folder.deleted_at == restore_timestamp
        ).update({"deleted_at": None, "parent_id": parent_id}, synchronize_session="fetch")
        if not restored:
            db.rollback()
            raise HTTPException(status_code=404, detail="Deleted folder not found")

        descendant_ids = _get_descendant_ids_including_deleted(db, folder_id)
        db.query(Folder).filter(
            Folder.id.in_(descendant_ids), Folder.deleted_at == restore_timestamp
        ).update({"deleted_at": None}, synchronize_session="fetch")
        db.query(Asset).filter(
            Asset.folder_id.in_([folder_id] + descendant_ids),
            Asset.deleted_at == restore_timestamp,
            _can_restore_folder_asset(),
        ).update({"deleted_at": None}, synchronize_session="fetch")

        db.commit()
    return {"ok": True}
