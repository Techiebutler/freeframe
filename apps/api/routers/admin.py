"""Admin endpoints: user management, and the storage overview."""

from datetime import datetime, timedelta, timezone
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
    BackfillStartResponse,
    PurgeStartResponse,
    StorageOverviewResponse,
    StorageProjectFilesResponse,
)

router = APIRouter(prefix="/admin", tags=["admin"])

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
