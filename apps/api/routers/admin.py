"""Admin endpoints: user management, and the storage overview."""

from datetime import datetime, timedelta, timezone
import logging
import secrets

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
import uuid

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.project import Project
from ..models.user import User, UserStatus
from ..schemas.auth import UserResponse, AdminUserResponse, UpdateUserRoleRequest
from .users import require_admin
from ..tasks.celery_app import send_task_safe
from ..tasks.cleanup_tasks import cleanup_soft_deleted
from ..tasks.storage_tasks import backfill_media_derived_size
from ..services import admin_panel
from ..schemas.admin import (
    AdminDeleteRequest,
    AdminDeleteResponse,
    AdminPurgeRequest,
    AdminPurgeResponse,
    AdminRestoreRequest,
    AdminRestoreResponse,
    BackfillStartResponse,
    PurgeStartResponse,
    StorageOverviewResponse,
    StorageProjectFilesResponse,
    TrashResponse,
)

router = APIRouter(prefix="/admin", tags=["admin"])

log = logging.getLogger(__name__)

#: How many project rows the storage overview returns by default, and the most
#: it will return at all. The question it answers is which projects take up the
#: space: the largest few hundred answer it, and the instance totals in the
#: summary are never affected by the cap. `project_count` in the response says
#: how many there are, so a truncated list says so rather than looking
#: complete.
DEFAULT_PROJECT_LIMIT = 200
MAX_PROJECT_LIMIT = 1000


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/users", response_model=list[AdminUserResponse])
def list_all_users(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all users in the system. Only accessible by admins."""
    if not current_user.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can access this endpoint"
        )

    users = db.query(User).filter(User.deleted_at.is_(None)).all()
    return users

@router.patch("/users/{user_id}/deactivate", response_model=AdminUserResponse)
def deactivate_user(
    user_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Deactivate a user. Admins cannot deactivate themselves."""
    if not current_user.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can deactivate users"
        )

    # Prevent admin from deactivating themselves
    if user_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot deactivate yourself"
        )

    user = db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.status = UserStatus.deactivated
    # Deactivating a pending invitee withdraws the invite, so a later
    # Reactivate doesn't bring the old link back to life.
    user.invite_token = None
    user.invite_token_expires_at = None
    db.commit()
    db.refresh(user)
    return user

@router.patch("/users/{user_id}/reactivate", response_model=AdminUserResponse)
def reactivate_user(
    user_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Reactivate a deactivated user. Only accessible by admins."""
    if not current_user.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can reactivate users"
        )

    user = db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if user.password_hash is None and not user.email_verified:
        # An invitee who never accepted has no way in once deactivation cleared
        # their link, so they go back to pending with a fresh one to copy.
        user.status = UserStatus.pending_invite
        user.invite_token = secrets.token_urlsafe(48)
        user.invite_token_expires_at = datetime.now(timezone.utc) + timedelta(days=7)
    else:
        user.status = UserStatus.active
    db.commit()
    db.refresh(user)
    return user

@router.patch("/users/{user_id}/role", response_model=AdminUserResponse)
def update_user_role(
    user_id: uuid.UUID,
    body: UpdateUserRoleRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Promote or demote a user to/from admin role. Only accessible by admins."""
    if not current_user.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can change user roles"
        )

    # Prevent admin from removing their own admin role
    if user_id == current_user.id and not body.is_admin:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot remove your own admin role"
        )

    user = db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.is_superadmin = body.is_admin
    db.commit()
    db.refresh(user)
    return user

@router.post("/purge", response_model=PurgeStartResponse, status_code=status.HTTP_202_ACCEPTED)
def purge_now(current_user: User = Depends(require_admin)):
    """Trigger the retention-window garbage collector to run now, in the background.

    Superadmin only. Enqueues the same `cleanup_soft_deleted` task the daily beat runs, so the
    request returns immediately instead of blocking on a potentially long cascade + S3 deletes.
    Reclaimed counts are logged by the worker. If a purge is already running (e.g. the daily beat),
    the advisory lock serializes purges and this enqueued run is skipped rather than double-cascading,
    so a 202 here means "enqueued", not "a fresh run happened".
    """
    send_task_safe(cleanup_soft_deleted)
    return PurgeStartResponse(
        status="started",
        detail="Retention garbage collection is running in the background; see worker logs for reclaimed counts.",
    )


# ── The storage overview ──────────────────────────────────────────────────────
#
# What the instance holds, in one summary line and a list of projects by size.
# Every endpoint here is superadmin-only through `require_admin`, enforced on
# the server. Only the backfill changes anything, and all it writes is the
# measured size of output the instance already has.


@router.get("/storage", response_model=StorageOverviewResponse)
def storage_overview(
    limit: int = Query(
        DEFAULT_PROJECT_LIMIT, ge=1, le=MAX_PROJECT_LIMIT,
        description="How many of the largest projects to return.",
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """One summary line, then the projects by size. Superadmin only.

    A grouped sum over `media_files`, so this never lists the object store:
    derived bytes are measured once when a transcode finishes and stored on the
    row. Projects holding no committed bytes are left out, having nothing to
    show on a storage page.

    The list is bounded: the largest few hundred projects answer what takes up
    the space. `project_count` reports how many there are so a truncated list
    says so, and the summary is instance-wide either way.
    """
    projects, project_count = admin_panel.storage_project_rows(db, limit)
    return StorageOverviewResponse(
        summary=admin_panel.storage_summary(db),
        projects=projects,
        project_count=project_count,
        limit=limit,
    )


@router.get("/storage/projects/{project_id}", response_model=StorageProjectFilesResponse)
def storage_project_files(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """One project's files, largest first. Superadmin only; fetched when a row
    is expanded, so opening the panel does not load every file on the instance."""
    project = db.query(Project).filter(
        Project.id == project_id, Project.deleted_at.is_(None),
    ).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return StorageProjectFilesResponse(
        project_id=project_id,
        name=project.name,
        assets=admin_panel.storage_asset_rows(db, project_id),
    )


@router.post("/delete", response_model=AdminDeleteResponse)
def admin_delete(
    body: AdminDeleteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Move a confirmed selection of projects and files into the trash.

    Superadmin only, and **soft delete only**. Rows get a `deleted_at`, the same
    trash every other delete in the app uses, and the existing retention
    collector reclaims the bytes after `SOFT_DELETE_RETENTION_DAYS` (30 by
    default). Permanent deletion is a separate action in the Trash view.

    The confirmation gate is enforced here, not in the browser:

    * `409` when part of the selection is already gone, when `confirm_count`
      disagrees with what the server resolved, or when an asset's newest version
      was picked without the asset itself. A bulk delete that silently covers a
      different set than was confirmed is the failure this prevents.
    * `428` when the selection is past a threshold (more than one project, or
      more than 10 GB) and the confirmation phrase was not typed.

    The action is recorded in `activity_logs` as `admin_bulk_delete`: once for
    the action and once per project, asset and version, in the request's own
    transaction, so a rolled-back delete leaves no entry claiming otherwise.
    """
    targets = admin_panel.resolve_targets(
        db, body.project_ids, body.asset_ids, body.version_ids,
    )
    try:
        admin_panel.check_gate(db, targets, body.confirm_count, body.confirm_text)
    except admin_panel.DeleteGate as gate:
        raise HTTPException(status_code=gate.status_code, detail=gate.detail)

    result = admin_panel.bulk_soft_delete(db, targets, current_user)
    db.commit()
    return AdminDeleteResponse(**result)


@router.get("/trash", response_model=TrashResponse)
def admin_trash(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """What is in the trash and how many days it has left. Superadmin only."""
    return admin_panel.trash_rows(db)


@router.post("/trash/restore", response_model=AdminRestoreResponse)
def admin_restore(
    body: AdminRestoreRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Take projects and files back out of the trash. Superadmin only.

    Clearing `deleted_at` is the whole operation. The retention collector
    re-checks and locks each row immediately before it cascades, so a restore
    racing a collector pass is already safe.

    This is the bulk counterpart of `POST /projects/{id}/restore`: the app's
    per-project trash restores assets and folders, and a soft-deleted project
    had no restore path at all before. Without one, a delete from this panel
    would not have been reversible, which is the whole point of routing it
    through the trash.

    `409` when anything named was deleted longer ago than the retention window,
    the same refusal the single-project endpoint gives; the whole request is
    refused rather than the stale part skipped. The restore is recorded in
    `activity_logs` as `admin_restore`, once for the action and once per
    project, in the request's own transaction.
    """
    try:
        result = admin_panel.restore(
            db, body.project_ids, body.asset_ids, body.version_ids, actor=current_user,
        )
    except admin_panel.RestoreGate as gate:
        raise HTTPException(status_code=gate.status_code, detail=gate.detail)
    db.commit()
    log.info(
        "admin restore by %s: %s projects, %s assets, %s versions, %s blocked, %s skipped",
        current_user.id, result["restored_projects"], result["restored_assets"],
        result["restored_versions"], len(result["blocked_by_parent"]),
        len(result["skipped"]),
    )
    return AdminRestoreResponse(**result)


@router.post("/trash/purge", response_model=AdminPurgeResponse)
def admin_purge_trash(
    body: AdminPurgeRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Empty the trash for good, now, and free the bytes. Superadmin only.

    **This is the one action in the panel that cannot be undone.** Everything
    else soft-deletes and waits out the retention window; this removes the rows
    and their object-store keys immediately, which is the point: a full disk
    today is not helped by a reclaim scheduled for next month.

    It can only ever reach what is **already in the trash**. An id naming a live
    project answers 409 rather than being deleted, so there is no path from the
    list of active projects to a permanent delete; a project goes to the trash
    first, and is purged from there as a second, separately confirmed decision.

    The gate, all of it enforced here and none of it in the browser:

    * `409` when anything named is not in the trash, when `confirm_count`
      disagrees with what the server resolved, or when `confirm_bytes` does. The
      two figures are the ones the dialog showed; a page that has moved on
      cannot destroy a different amount than was confirmed.
    * `428` when the confirmation phrase was not typed. Required at every size,
      unlike the soft delete's threshold, because nothing here is recoverable.
    * `409` when a scheduled cleanup pass holds the collector's advisory lock.

    Reclaim runs through `tasks/cleanup_tasks`, the same cascade the nightly
    collector uses, so originals, renditions, HLS segments, single-file
    downloads and poster thumbnails are removed by code that is already
    exercised every night rather than by a second implementation here.

    Recorded as `admin_trash_purge` in `activity_logs` with who, when and how
    much, and logged at WARNING: it is the only record that these bytes existed.
    """
    targets = admin_panel.trash_purge_targets(
        db, body.project_ids, body.asset_ids, body.version_ids, body.everything,
    )
    try:
        # Both of these raise before anything is written: the gate is pure
        # arithmetic over what was resolved, and the lock check inside
        # `purge_from_trash` runs ahead of the first cascade. A refusal
        # therefore leaves the transaction untouched and needs no rollback,
        # which also keeps this endpoint from reaching outside its own unit of
        # work.
        admin_panel.check_purge_gate(
            targets, body.confirm_count, body.confirm_bytes, body.confirm_text,
        )
        result = admin_panel.purge_from_trash(db, targets, current_user)
    except admin_panel.PurgeGate as gate:
        raise HTTPException(status_code=gate.status_code, detail=gate.detail)

    # Rows first, objects second. The cascade only collected the keys; a process
    # that dies before this commit leaves rows that are still in the trash and
    # still have their media, where the other order left a restorable row whose
    # objects were already gone. `reclaim_objects` then deletes them and amends
    # the audit row with what the store really did.
    db.commit()
    admin_panel.reclaim_objects(db, result)
    return AdminPurgeResponse(
        **{k: v for k, v in result.items() if not k.startswith("_")}
    )


@router.post(
    "/storage/backfill",
    response_model=BackfillStartResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def storage_backfill(current_user: User = Depends(require_admin)):
    """Measure derived bytes for media that has never been measured.

    Superadmin only. Enqueues `backfill_media_derived_size` on the maintenance
    queue: one bucket listing per unmeasured version, which is why it does not
    run in the request. Idempotent, resumable, and safe to run while the
    instance is serving; a 202 means "enqueued", not "finished".

    Calling it twice does not run it twice. The task takes a Postgres advisory
    lock and a second run returns immediately, the same way `/admin/purge`
    serializes against the daily beat; it also pauses between batches so a long
    backfill leaves S3 request budget for the people working on the instance.
    """
    send_task_safe(backfill_media_derived_size)
    return BackfillStartResponse(
        status="started",
        detail=(
            "Measuring storage in the background. Read the overview again to "
            "see the unmeasured count fall; see worker logs for totals."
        ),
    )
