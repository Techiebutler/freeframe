from fastapi import APIRouter, Depends, HTTPException, Query, status, UploadFile, File
from sqlalchemy.orm import Session
from sqlalchemy import func
import uuid
from datetime import datetime, timedelta, timezone
from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.asset import Asset
from ..schemas.project import ProjectCreate, ProjectUpdate, ProjectResponse, ProjectMemberResponse, AddProjectMemberRequest, UpdateProjectMemberRequest
from ..tasks.email_tasks import send_project_added_email
from ..tasks.celery_app import send_task_safe
from ..services.s3_service import put_object, generate_presigned_get_url, delete_object
from ..services.storage import project_storage_used_bytes, project_storage_used_bytes_map
from ..services.activity_service import log_activity
from ..services.permissions import (
    is_instance_admin,
    require_project_role,
    require_project_visible,
)
from ..config import settings

router = APIRouter(prefix="/projects", tags=["projects"])

def _get_project(db: Session, project_id: uuid.UUID) -> Project:
    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project

def _resolve_poster_url(project: Project) -> str | None:
    if project.poster_s3_key:
        return generate_presigned_get_url(project.poster_s3_key)
    return None

def _require_project_owner(
    db: Session, project_id: uuid.UUID, user: User, project: Project | None = None,
) -> ProjectMember:
    """Owner tier, through the one central gate.

    It used to query project_members here, which left this router as the only
    place a superadmin's instance-wide access would have had to be repeated.
    Every caller has already loaded the live project through `_get_project`, so
    it is handed over rather than looked up a second time.
    """
    return require_project_role(db, project_id, user, ProjectRole.owner, project=project)

def _live_owner_ids(db: Session, project_id: uuid.UUID) -> set[uuid.UUID]:
    """User ids holding a live owner membership on this project."""
    return {
        uid
        for (uid,) in db.query(ProjectMember.user_id).filter(
            ProjectMember.project_id == project_id,
            ProjectMember.role == ProjectRole.owner,
            ProjectMember.deleted_at.is_(None),
        ).all()
    }

def _refuse_losing_last_owner(db: Session, project_id: uuid.UUID, user_id: uuid.UUID) -> None:
    """Refuse removing or demoting the project's only owner.

    A project without an owner cannot be managed by any of its own members: every
    membership-editing endpoint here is owner tier, so the people in the project
    would be locked out of their own settings with no way back from inside.

    Checked for both removal and a role change, because demoting the last owner
    leaves exactly the same project behind as removing them. An instance
    superadmin could still reach in and appoint someone, but relying on that
    would make every ownerless project an admin ticket.
    """
    owners = _live_owner_ids(db, project_id)
    if owners == {user_id}:
        raise HTTPException(
            status_code=400,
            detail="This is the project's only owner. Give someone else Full Access first.",
        )

@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def create_project(body: ProjectCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = Project(
        name=body.name,
        description=body.description,
        project_type=body.project_type,
        created_by=current_user.id,
    )
    db.add(project)
    db.flush()
    member = ProjectMember(project_id=project.id, user_id=current_user.id, role=ProjectRole.owner)
    db.add(member)
    db.commit()
    db.refresh(project)
    return project

@router.get("", response_model=list[ProjectResponse])
def list_projects(
    scope: str = Query(
        "mine",
        pattern="^(mine|all)$",
        description=(
            "`mine` (default): memberships plus public projects, as always. "
            "`all`: every live project on the instance, for an instance "
            "superadmin only; anyone else is answered 403."
        ),
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from sqlalchemy import or_

    # Get memberships for current user
    memberships = db.query(ProjectMember).filter(
        ProjectMember.user_id == current_user.id,
        ProjectMember.deleted_at.is_(None),
    ).all()
    membership_map = {m.project_id: m.role for m in memberships}
    member_project_ids = list(membership_map.keys())

    if scope == "all":
        # Deliberately 403 rather than a silent fall back to `mine`: the toggle
        # in the UI would otherwise look like it worked and show one list while
        # claiming another.
        if not is_instance_admin(current_user):
            raise HTTPException(status_code=403, detail="Admin access required")
        projects = db.query(Project).filter(Project.deleted_at.is_(None)).all()
    else:
        # Get projects: user's memberships + all public projects
        projects = db.query(Project).filter(
            Project.deleted_at.is_(None),
            or_(
                Project.id.in_(member_project_ids) if member_project_ids else False,
                Project.is_public == True,
            ),
        ).all()

    all_project_ids = [p.id for p in projects]
    if not all_project_ids:
        return []

    # Batch: asset counts per project
    asset_counts = dict(
        db.query(Asset.project_id, func.count(Asset.id))
        .filter(Asset.project_id.in_(all_project_ids), Asset.deleted_at.is_(None))
        .group_by(Asset.project_id)
        .all()
    )

    # Batch: used storage per project, the one definition in services.storage —
    # not a second copy of the join and the filter, which is how the member
    # indicator and the upload limit once came to count different bytes.
    storage_map = project_storage_used_bytes_map(db, all_project_ids)

    # Batch: member counts per project
    member_counts = dict(
        db.query(ProjectMember.project_id, func.count(ProjectMember.id))
        .filter(ProjectMember.project_id.in_(all_project_ids), ProjectMember.deleted_at.is_(None))
        .group_by(ProjectMember.project_id)
        .all()
    )

    result = []
    for p in projects:
        resp = ProjectResponse.model_validate(p)
        resp.poster_url = _resolve_poster_url(p)
        resp.asset_count = asset_counts.get(p.id, 0)
        resp.storage_bytes = storage_map.get(p.id, 0)
        resp.member_count = member_counts.get(p.id, 0)
        resp.role = membership_map.get(p.id)
        result.append(resp)

    return result

@router.get("/{project_id}", response_model=ProjectResponse)
def get_project(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = _get_project(db, project_id)
    # One central gate: 404 for a deleted project, 403 unless the caller is a
    # member, the project is public, or the caller is an instance superadmin.
    member = require_project_visible(db, project_id, current_user, project)
    resp = ProjectResponse.model_validate(project)
    resp.poster_url = _resolve_poster_url(project)
    if member:
        resp.role = member.role
    # Calculate storage, asset count, member count
    resp.asset_count = db.query(func.count(Asset.id)).filter(
        Asset.project_id == project_id, Asset.deleted_at.is_(None),
    ).scalar() or 0
    resp.storage_bytes = project_storage_used_bytes(db, project_id)
    resp.member_count = db.query(func.count(ProjectMember.id)).filter(
        ProjectMember.project_id == project_id, ProjectMember.deleted_at.is_(None),
    ).scalar() or 0
    return resp

@router.patch("/{project_id}", response_model=ProjectResponse)
def update_project(project_id: uuid.UUID, body: ProjectUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user, project)
    if body.name is not None:
        project.name = body.name
    # Sent as null or "" clears the description; left out keeps it.
    if "description" in body.model_fields_set:
        project.description = body.description or None
    if body.is_public is not None:
        project.is_public = body.is_public
    db.commit()
    db.refresh(project)
    resp = ProjectResponse.model_validate(project)
    resp.poster_url = _resolve_poster_url(project)
    return resp

@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user, project)
    project.deleted_at = datetime.now(timezone.utc)
    db.commit()

@router.post("/{project_id}/restore", response_model=dict)
def restore_project(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Take a soft-deleted project back out of the trash.

    The counterpart to `DELETE /{project_id}`, and the missing half of the
    window `SOFT_DELETE_RETENTION_DAYS` keeps the rows for. Until this existed a
    deleted project was present but unreachable for everyone: no endpoint, no
    page, and the only way back was an UPDATE against the database by hand. The
    delete dialog said so, and says so still for an owner without Admin.

    `_get_project` cannot be used, because it insists on a live project and this
    one is deliberately not. The role check is `require_project_role` all the
    same, handed the trashed row it already loaded, so this endpoint inherits
    the one gate instead of spelling a second superadmin rule out by hand:

    * An owner of the project, by a membership that is itself still live. A
      member whose own membership was removed is not an owner any more.
    * Or an instance superadmin, exactly as everywhere else in this router, and
      audited as `admin_project_access` like every other reach past an admin's
      own membership. The row is written before the retention window is checked,
      so a refused restore still records that an outsider was in there; that is
      the honest order, because answering 409 before the role check would tell a
      stranger when the project was deleted.
    * Inside the retention window, or 409. Past it the row is the collector's,
      and reporting a restore that the next nightly pass undoes would be worse
      than refusing.

    The UPDATE is guarded on the row still being in the trash, so a restore that
    races the collector's locked cascade matches nothing and answers 404 rather
    than resurrecting a half-purged project.
    """
    project = db.query(Project).filter(
        Project.id == project_id, Project.deleted_at.isnot(None),
    ).first()
    if not project:
        raise HTTPException(status_code=404, detail="Deleted project not found")

    require_project_role(
        db, project_id, current_user, ProjectRole.owner,
        project=project, include_trashed=True,
    )

    days = settings.soft_delete_retention_days
    if days > 0 and project.deleted_at is not None:
        deleted_at = project.deleted_at
        if deleted_at.tzinfo is None:
            deleted_at = deleted_at.replace(tzinfo=timezone.utc)
        if deleted_at < datetime.now(timezone.utc) - timedelta(days=days):
            raise HTTPException(
                status_code=409,
                detail=f"This project was deleted more than {days} days ago and can no longer be restored.",
            )

    # Read before the UPDATE: `synchronize_session="fetch"` clears it on the
    # instance, and the log line is about the deletion this undid.
    was_deleted_at = project.deleted_at
    restored = db.query(Project).filter(
        Project.id == project_id, Project.deleted_at.isnot(None),
    ).update({"deleted_at": None}, synchronize_session="fetch")
    if not restored:
        db.rollback()
        raise HTTPException(status_code=404, detail="Deleted project not found")
    # Logged here and not only in the admin panel: putting a project back in
    # front of its members is the same reach as taking it away, and a superadmin
    # who is not a member can do it. Rides this request's transaction, so a
    # rolled-back restore leaves no entry claiming otherwise.
    log_activity(
        db,
        "project_restored",
        user_id=current_user.id,
        project_id=project_id,
        payload={
            "via": "project_endpoint",
            "by_superadmin": bool(current_user.is_superadmin),
            "deleted_at": was_deleted_at.isoformat() if was_deleted_at else None,
        },
    )
    db.commit()
    return {"ok": True}

@router.get("/{project_id}/members", response_model=list[ProjectMemberResponse])
def list_project_members(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = _get_project(db, project_id)
    # Viewer tier: any member, and an instance superadmin. A public project
    # still does not expose its member list to non-members, as before.
    require_project_role(db, project_id, current_user, ProjectRole.viewer, project=project)

    members = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.deleted_at.is_(None),
    ).all()
    return members

@router.post("/{project_id}/members", response_model=ProjectMemberResponse, status_code=status.HTTP_201_CREATED)
def add_project_member(project_id: uuid.UUID, body: AddProjectMemberRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user, project)
    existing = db.query(ProjectMember).filter(ProjectMember.project_id == project_id, ProjectMember.user_id == body.user_id).first()
    if existing:
        if existing.deleted_at is None:
            raise HTTPException(status_code=400, detail="User already a project member")
        # Reactivate soft-deleted membership. It is a new membership as far as
        # the member list's joined date and inviter go.
        existing.deleted_at = None
        existing.role = body.role
        existing.invited_by = current_user.id
        existing.invited_at = func.now()
        db.commit()
        db.refresh(existing)
        member = existing
    else:
        member = ProjectMember(project_id=project_id, user_id=body.user_id, role=body.role, invited_by=current_user.id)
        db.add(member)
        db.commit()
        db.refresh(member)

    # Send project added email (for both new and reactivated members)
    project = _get_project(db, project_id)
    added_user = db.query(User).filter(User.id == body.user_id).first()
    if added_user:
        project_link = f"{settings.frontend_url}/projects/{project_id}"
        send_task_safe(send_project_added_email,
            to_email=added_user.email,
            adder_name=current_user.name,
            project_name=project.name,
            project_link=project_link,
            role=body.role.value if body.role else None,
        )

    return member

@router.patch("/{project_id}/members/{user_id}", response_model=ProjectMemberResponse)
def update_project_member(project_id: uuid.UUID, user_id: uuid.UUID, body: UpdateProjectMemberRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user, project)
    member = db.query(ProjectMember).filter(ProjectMember.project_id == project_id, ProjectMember.user_id == user_id, ProjectMember.deleted_at.is_(None)).first()
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    if member.role == ProjectRole.owner and body.role != ProjectRole.owner:
        _refuse_losing_last_owner(db, project_id, user_id)
    member.role = body.role
    db.commit()
    db.refresh(member)
    return member

@router.delete("/{project_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_project_member(project_id: uuid.UUID, user_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user, project)
    member = db.query(ProjectMember).filter(ProjectMember.project_id == project_id, ProjectMember.user_id == user_id, ProjectMember.deleted_at.is_(None)).first()
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    if member.role == ProjectRole.owner:
        _refuse_losing_last_owner(db, project_id, user_id)
    member.deleted_at = datetime.now(timezone.utc)
    db.commit()

ALLOWED_POSTER_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_POSTER_SIZE = 10 * 1024 * 1024  # 10MB

@router.post("/{project_id}/poster", response_model=ProjectResponse)
async def upload_project_poster(
    project_id: uuid.UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    project = _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user, project)

    if file.content_type not in ALLOWED_POSTER_TYPES:
        raise HTTPException(status_code=400, detail="File must be JPEG, PNG, WebP, or GIF")

    data = await file.read()
    if len(data) > MAX_POSTER_SIZE:
        raise HTTPException(status_code=400, detail="File must be under 10MB")

    # Delete old poster if exists
    if project.poster_s3_key:
        try:
            delete_object(project.poster_s3_key)
        except Exception:
            pass

    ext = file.filename.rsplit(".", 1)[-1].lower() if file.filename and "." in file.filename else "jpg"
    s3_key = f"posters/{project_id}/poster.{ext}"
    put_object(s3_key, data, content_type=file.content_type, cache_control="max-age=86400")

    project.poster_s3_key = s3_key
    db.commit()
    db.refresh(project)

    resp = ProjectResponse.model_validate(project)
    resp.poster_url = _resolve_poster_url(project)
    return resp

@router.delete("/{project_id}/poster", status_code=status.HTTP_204_NO_CONTENT)
def remove_project_poster(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    project = _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user, project)

    if project.poster_s3_key:
        try:
            delete_object(project.poster_s3_key)
        except Exception:
            pass
        project.poster_s3_key = None
        db.commit()
