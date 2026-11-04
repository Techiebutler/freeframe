import re
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from sqlalchemy.orm import Session
from sqlalchemy import func
import uuid
from datetime import datetime, timezone
from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User, UserStatus
from pydantic import BaseModel, ConfigDict, Field
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.asset import Asset, AssetType, AssetVersion, MediaFile, ProcessingStatus
from ..schemas.project import ProjectCreate, ProjectUpdate, ProjectResponse, ProjectMemberResponse, AddProjectMemberRequest, UpdateProjectMemberRequest
from ..tasks.email_tasks import send_project_added_email
from ..tasks.celery_app import send_task_safe
from ..services.s3_service import put_object, generate_presigned_get_url, delete_object
from ..services.storage import project_storage_used_bytes
from ..services.permissions import effective_project_role, implicit_project_role, higher_role, is_staff
from ..config import settings
from ..services import automation_share
from ..services.whop_auth import ensure_customer_workspace

router = APIRouter(prefix="/projects", tags=["projects"])


class ReviewBrandIdentity(BaseModel):
    model_config = ConfigDict(extra='forbid')
    card_id: str = Field(pattern=r'^[a-f0-9]{24}$')
    board_id: str = Field(pattern=r'^[a-f0-9]{24}$')
    brand_slug: str = Field(min_length=1, max_length=255, pattern=r'^[a-z0-9]+(?:-[a-z0-9]+)*$')


class ReviewBrandConfirmation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    trello_url: str = Field(min_length=1, max_length=2000)
    apply: bool = False
    expected: ReviewBrandIdentity | None = None


@router.post('/{project_id}/review-brand', include_in_schema=False)
def confirm_review_brand(project_id: uuid.UUID, body: ReviewBrandConfirmation,
                         db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    if current_user.is_staff is not True or current_user.status != UserStatus.active:
        raise HTTPException(403, 'Active staff owner required')
    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).populate_existing().with_for_update().first()
    if project is None or not project.is_workspace:
        raise HTTPException(404, 'Staff workspace not found')
    creator = db.query(User).filter(User.id == project.created_by, User.deleted_at.is_(None)).first()
    if creator is None or creator.is_staff is not True or creator.status != UserStatus.active:
        raise HTTPException(403, 'Staff-owned workspace required')
    from ..services.permissions import require_project_role
    require_project_role(db, project.id, current_user, ProjectRole.owner)
    from ..services.project_brands import propose_brand
    return propose_brand(db, project, current_user, body.trello_url, body.apply,
                         body.expected.model_dump() if body.expected else None)

def _get_project(db: Session, project_id: uuid.UUID) -> Project:
    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project

def _auto_poster_keys(db: Session, project_ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    """Newest non-audio asset's thumbnail key per project, for projects with no
    manual poster set. Mirrors how assets resolve their own thumbnail (first media
    file with s3_key_thumbnail on the asset's latest version); newest asset wins so
    the cover stays current as new work lands. Audio stores waveform JSON in
    s3_key_thumbnail, not an image, so audio assets are excluded."""
    if not project_ids:
        return {}

    # Latest (highest version_number) non-deleted version per asset.
    latest_version_subq = (
        db.query(
            AssetVersion.asset_id.label("asset_id"),
            func.max(AssetVersion.version_number).label("max_version"),
        )
        .filter(AssetVersion.deleted_at.is_(None))
        .group_by(AssetVersion.asset_id)
        .subquery()
    )

    rows = (
        db.query(Asset.project_id, MediaFile.s3_key_thumbnail)
        .join(latest_version_subq, latest_version_subq.c.asset_id == Asset.id)
        .join(
            AssetVersion,
            (AssetVersion.asset_id == Asset.id)
            & (AssetVersion.version_number == latest_version_subq.c.max_version),
        )
        .join(MediaFile, MediaFile.version_id == AssetVersion.id)
        .filter(
            Asset.project_id.in_(project_ids),
            Asset.deleted_at.is_(None),
            Asset.asset_type != AssetType.audio,
            MediaFile.s3_key_thumbnail.isnot(None),
        )
        # Newest asset first per project; for a carousel, its lowest sequence_order.
        .order_by(
            Asset.project_id,
            Asset.created_at.desc(),
            Asset.id.desc(),
            MediaFile.sequence_order.asc(),
        )
        .all()
    )

    poster_by_project: dict[uuid.UUID, str] = {}
    for project_id, thumb_key in rows:
        poster_by_project.setdefault(project_id, thumb_key)
    return poster_by_project

def _resolve_poster_url(db: Session, project: Project) -> str | None:
    """Manual project poster if set, else the newest asset's thumbnail."""
    if project.poster_s3_key:
        return generate_presigned_get_url(project.poster_s3_key)
    key = _auto_poster_keys(db, [project.id]).get(project.id)
    return generate_presigned_get_url(key) if key else None

def _require_project_owner(db: Session, project_id: uuid.UUID, user: User) -> ProjectRole:
    if effective_project_role(db, project_id, user) != ProjectRole.owner:
        raise HTTPException(status_code=403, detail="Project owner access required")
    return ProjectRole.owner

def _check_description_requirement(description: str | None) -> None:
    """Enforce settings.require_project_description_pattern, when an instance sets one.

    Off by default: an empty pattern skips this entirely, so existing instances see no change.
    """
    pattern = (settings.require_project_description_pattern or "").strip()
    if not pattern:
        return
    if description and re.search(pattern, description, re.IGNORECASE):
        return
    hint = (settings.require_project_description_hint or "").strip()
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=hint or "This instance requires a link in the project description.",
    )


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def create_project(body: ProjectCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # A workspace (project) is created only by a superadmin - and the brand-onboarding automation,
    # which acts as one. Editors file every hand-in into an EXISTING brand workspace via /handin.
    # Letting editors create projects produced per-card junk projects whose share link showed
    # nothing (the videos sat in a folder in a different project), which is what "the videos are not
    # in the folder" turned out to be. One workspace per brand; nobody spins up a per-card project.
    # Platform v2: a CUSTOMER (is_staff false) creates their own brand workspace - it is theirs
    # alone, they are its only member. Staff editors still file into existing workspaces.
    is_customer = getattr(current_user, "is_staff", True) is False
    if not getattr(current_user, "is_superadmin", False) and not is_customer:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only an admin can create a workspace. File your hand-in into an existing workspace instead.",
        )
    if not is_customer:
        _check_description_requirement(body.description)
    from ..services.campaign_access import require_brand_slot
    require_brand_slot(db, current_user)
    project = Project(
        name=body.name,
        description=body.description,
        project_type=body.project_type,
        is_workspace=body.is_workspace,
        created_by=current_user.id,
    )
    db.add(project)
    db.flush()
    member = ProjectMember(project_id=project.id, user_id=current_user.id, role=ProjectRole.owner)
    db.add(member)
    # A standing link for the automation, created WITH the project so nobody has to remember. Off
    # unless a webhook URL is configured. See services/automation_share.py.
    # Not for a customer's workspace: their hand-ins are file requests, each with its own link.
    link = None if is_customer else automation_share.create_standing_link(db, project.id, current_user.id)
    db.commit()
    db.refresh(project)
    # Announce AFTER the commit: a webhook that fires for a project the database then rolls back
    # would have the automation watching something that does not exist.
    if link is not None:
        automation_share.announce(project, link)
    return project

@router.get("", response_model=list[ProjectResponse])
def list_projects(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    from sqlalchemy import or_

    # Also repair accounts signed in before automatic brand provisioning was introduced.
    if current_user.is_staff is False and isinstance(current_user.suite_brand_id, str) and current_user.suite_brand_id:
        ensure_customer_workspace(db, current_user)

    # Get memberships for current user
    memberships = db.query(ProjectMember).filter(
        ProjectMember.user_id == current_user.id,
        ProjectMember.deleted_at.is_(None),
    ).all()
    membership_map = {m.project_id: m.role for m in memberships}
    member_project_ids = list(membership_map.keys())

    # An instance-wide role covers every project, so there is nothing to filter by.
    implicit_role = implicit_project_role(current_user)
    if implicit_role:
        projects = db.query(Project).filter(Project.deleted_at.is_(None)).all()
    else:
        # Get projects: user's memberships + all public projects
        # A customer sees only projects it is a member of - public ones are a staff convenience.
        visible = [Project.id.in_(member_project_ids) if member_project_ids else False]
        if is_staff(current_user):
            visible.append(Project.is_public == True)
        projects = db.query(Project).filter(Project.deleted_at.is_(None), or_(*visible)).all()

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

    # Batch: storage bytes per project (sum of file sizes)
    storage_query = (
        db.query(Asset.project_id, func.coalesce(func.sum(MediaFile.file_size_bytes), 0))
        .join(AssetVersion, AssetVersion.asset_id == Asset.id)
        .join(MediaFile, MediaFile.version_id == AssetVersion.id)
        # Committed-only usage — matches services.storage.instance_storage_used_bytes
        .filter(
            Asset.project_id.in_(all_project_ids), Asset.deleted_at.is_(None),
            AssetVersion.deleted_at.is_(None),
            AssetVersion.processing_status.in_([ProcessingStatus.processing, ProcessingStatus.ready]),
        )
        .group_by(Asset.project_id)
        .all()
    )
    storage_map = {pid: int(size) for pid, size in storage_query}

    # Batch: member counts per project
    member_counts = dict(
        db.query(ProjectMember.project_id, func.count(ProjectMember.id))
        .filter(ProjectMember.project_id.in_(all_project_ids), ProjectMember.deleted_at.is_(None))
        .group_by(ProjectMember.project_id)
        .all()
    )

    # Batch: auto-poster fallback (newest asset thumbnail) for projects with no
    # manual poster, so the grid never fires one query per card.
    auto_poster_map = _auto_poster_keys(
        db, [p.id for p in projects if not p.poster_s3_key]
    )

    result = []
    for p in projects:
        resp = ProjectResponse.model_validate(p)
        if p.poster_s3_key:
            resp.poster_url = generate_presigned_get_url(p.poster_s3_key)
        else:
            key = auto_poster_map.get(p.id)
            resp.poster_url = generate_presigned_get_url(key) if key else None
        resp.asset_count = asset_counts.get(p.id, 0)
        resp.storage_bytes = storage_map.get(p.id, 0)
        resp.member_count = member_counts.get(p.id, 0)
        resp.role = higher_role(membership_map.get(p.id), implicit_role)
        result.append(resp)

    return result

@router.get("/{project_id}", response_model=ProjectResponse)
def get_project(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = _get_project(db, project_id)
    role = effective_project_role(db, project_id, current_user)
    if not role and not (project.is_public and is_staff(current_user)):
        raise HTTPException(status_code=403, detail="Not a project member")
    resp = ProjectResponse.model_validate(project)
    resp.poster_url = _resolve_poster_url(db, project)
    # The client reads this to decide what to offer; a membership row is no longer
    # the only way to hold a role, so it must not be derived from the member list.
    resp.role = role
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
    _require_project_owner(db, project_id, current_user)
    if body.name is not None:
        project.name = body.name
    if body.description is not None:
        # Closing the same door on the way out: a project that had to carry the link to be
        # created should not be able to drop it on the next edit.
        if is_staff(current_user):
            _check_description_requirement(body.description)
        project.description = body.description
    if body.is_public is not None:
        # A customer cannot publish a project to every account on the instance.
        if body.is_public and not is_staff(current_user):
            raise HTTPException(status_code=403, detail="Only staff can make a project public.")
        project.is_public = body.is_public
    if body.is_workspace is not None:
        # An admin marks a project as a brand workspace (or unmarks a junk one) - this is what the
        # hand-in dropdown filters on.
        project.is_workspace = body.is_workspace
    if body.agents_may_approve is not None:
        project.agents_may_approve = body.agents_may_approve
    db.commit()
    db.refresh(project)
    resp = ProjectResponse.model_validate(project)
    resp.poster_url = _resolve_poster_url(db, project)
    return resp

@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user)
    project.deleted_at = datetime.now(timezone.utc)
    db.commit()

@router.get("/{project_id}/members", response_model=list[ProjectMemberResponse])
def list_project_members(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _get_project(db, project_id)
    # Verify the caller holds a role here at all
    if not effective_project_role(db, project_id, current_user):
        raise HTTPException(status_code=403, detail="Not a project member")

    members = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.deleted_at.is_(None),
    ).all()
    return members

@router.post("/{project_id}/members", response_model=ProjectMemberResponse, status_code=status.HTTP_201_CREATED)
def add_project_member(project_id: uuid.UUID, body: AddProjectMemberRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user)
    existing = db.query(ProjectMember).filter(ProjectMember.project_id == project_id, ProjectMember.user_id == body.user_id).first()
    if existing:
        if existing.deleted_at is None:
            raise HTTPException(status_code=400, detail="User already a project member")
        # Reactivate soft-deleted membership
        existing.deleted_at = None
        existing.role = body.role
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
    _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user)
    member = db.query(ProjectMember).filter(ProjectMember.project_id == project_id, ProjectMember.user_id == user_id, ProjectMember.deleted_at.is_(None)).first()
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    member.role = body.role
    db.commit()
    db.refresh(member)
    return member

@router.delete("/{project_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_project_member(project_id: uuid.UUID, user_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user)
    member = db.query(ProjectMember).filter(ProjectMember.project_id == project_id, ProjectMember.user_id == user_id, ProjectMember.deleted_at.is_(None)).first()
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
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
    _require_project_owner(db, project_id, current_user)

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
    resp.poster_url = _resolve_poster_url(db, project)
    return resp

@router.delete("/{project_id}/poster", status_code=status.HTTP_204_NO_CONTENT)
def remove_project_poster(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    project = _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user)

    if project.poster_s3_key:
        try:
            delete_object(project.poster_s3_key)
        except Exception:
            pass
        project.poster_s3_key = None
        db.commit()
