import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.project import ProjectRole
from ..models.share import ShareLink
from ..models.branding import (
    ProjectBranding,
    WatermarkSettings,
    WatermarkTemplate,
    WatermarkTemplateScope,
)
from ..schemas.branding import (
    BrandingUpdate,
    BrandingResponse,
    BrandingLogoUploadResponse,
    WatermarkUpdate,
    WatermarkResponse,
    WatermarkImageUploadResponse,
    WatermarkTemplateCreate,
    WatermarkTemplateUpdate,
    WatermarkTemplateResponse,
)
from ..services.permissions import require_project_role
from ..services import s3_service
from ..services import watermark_service
from ..config import settings

router = APIRouter(tags=["branding"])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_or_create_branding(db: Session, project_id: uuid.UUID) -> ProjectBranding:
    branding = db.query(ProjectBranding).filter(
        ProjectBranding.project_id == project_id
    ).first()
    if not branding:
        branding = ProjectBranding(project_id=project_id)
        db.add(branding)
        db.commit()
        db.refresh(branding)
    return branding


def _get_or_create_watermark(db: Session, project_id: uuid.UUID) -> WatermarkSettings:
    wm = db.query(WatermarkSettings).filter(
        WatermarkSettings.project_id == project_id,
        WatermarkSettings.share_link_id.is_(None),
    ).first()
    if not wm:
        # New project policies inherit the instance-wide defaults, mirroring
        # Frame.io's "account defaults apply to new workspaces" behavior.
        instance = watermark_service.get_instance_policy(db)
        wm = WatermarkSettings(
            project_id=project_id,
            require_internal=instance.require_internal if instance else False,
            require_shares=instance.require_shares if instance else False,
            template_id=instance.template_id if instance else None,
            exempt_roles=list(instance.exempt_roles) if instance and instance.exempt_roles else ["owner", "editor"],
        )
        db.add(wm)
        db.commit()
        db.refresh(wm)
    return wm


def _get_or_create_instance_watermark(db: Session) -> WatermarkSettings:
    wm = watermark_service.get_instance_policy(db)
    if not wm:
        wm = WatermarkSettings(project_id=None)
        db.add(wm)
        db.commit()
        db.refresh(wm)
    return wm


def _require_superadmin(current_user: User) -> None:
    if not current_user.is_superadmin:
        raise HTTPException(status_code=403, detail="Superadmin access required")


def _branding_to_response(branding: ProjectBranding) -> BrandingResponse:
    resp = BrandingResponse.model_validate(branding)
    if branding.logo_s3_key:
        try:
            resp.logo_url = s3_service.generate_presigned_get_url(branding.logo_s3_key)
        except Exception:
            resp.logo_url = None
    return resp


# ── Project Branding ──────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/branding", response_model=BrandingResponse)
def get_branding(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.viewer)
    branding = _get_or_create_branding(db, project_id)
    return _branding_to_response(branding)


@router.put("/projects/{project_id}/branding", response_model=BrandingResponse)
def upsert_branding(
    project_id: uuid.UUID,
    body: BrandingUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)
    branding = _get_or_create_branding(db, project_id)
    update_data = body.model_dump(exclude_none=True)
    for field, value in update_data.items():
        setattr(branding, field, value)
    db.commit()
    db.refresh(branding)
    return _branding_to_response(branding)


@router.post(
    "/projects/{project_id}/branding/logo-upload",
    response_model=BrandingLogoUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
def get_logo_upload_url(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)
    key = f"branding/{project_id}/logo/{uuid.uuid4()}.webp"
    upload_url = s3_service.get_s3_client().generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.s3_bucket,
            "Key": key,
            "ContentType": "image/webp",
        },
        ExpiresIn=3600,
    )
    return BrandingLogoUploadResponse(upload_url=upload_url, key=key)


# ── Watermark Settings ────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/watermark", response_model=WatermarkResponse)
def get_watermark(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.viewer)
    wm = _get_or_create_watermark(db, project_id)
    return WatermarkResponse.model_validate(wm)


@router.put("/projects/{project_id}/watermark", response_model=WatermarkResponse)
def upsert_watermark(
    project_id: uuid.UUID,
    body: WatermarkUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)
    wm = _get_or_create_watermark(db, project_id)
    update_data = body.model_dump(exclude_none=True)
    for field, value in update_data.items():
        setattr(wm, field, value)
    db.commit()
    db.refresh(wm)
    return WatermarkResponse.model_validate(wm)


@router.post(
    "/projects/{project_id}/watermark/image-upload",
    response_model=WatermarkImageUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
def get_watermark_image_upload_url(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)
    key = f"branding/{project_id}/watermark/{uuid.uuid4()}.png"
    upload_url = s3_service.get_s3_client().generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.s3_bucket,
            "Key": key,
            "ContentType": "image/png",
        },
        ExpiresIn=3600,
    )
    return WatermarkImageUploadResponse(upload_url=upload_url, key=key)


# ── Instance-wide Watermark Policy (superadmin) ──────────────────────────────

@router.get("/settings/watermark", response_model=WatermarkResponse)
def get_instance_watermark(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_superadmin(current_user)
    wm = _get_or_create_instance_watermark(db)
    return WatermarkResponse.model_validate(wm)


@router.put("/settings/watermark", response_model=WatermarkResponse)
def upsert_instance_watermark(
    body: WatermarkUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_superadmin(current_user)
    wm = _get_or_create_instance_watermark(db)
    update_data = body.model_dump(exclude_none=True)
    for field, value in update_data.items():
        setattr(wm, field, value)
    db.commit()
    db.refresh(wm)
    return WatermarkResponse.model_validate(wm)


# ── Watermark Templates ───────────────────────────────────────────────────────

def _get_template_or_404(db: Session, template_id: uuid.UUID) -> WatermarkTemplate:
    template = db.query(WatermarkTemplate).filter(
        WatermarkTemplate.id == template_id,
        WatermarkTemplate.deleted_at.is_(None),
    ).first()
    if not template:
        raise HTTPException(status_code=404, detail="Watermark template not found")
    return template


def _require_template_edit_access(
    db: Session, template: WatermarkTemplate, current_user: User
) -> None:
    if template.scope == WatermarkTemplateScope.instance:
        _require_superadmin(current_user)
    else:
        require_project_role(db, template.project_id, current_user, ProjectRole.editor)


@router.get("/watermark-templates", response_model=list[WatermarkTemplateResponse])
def list_instance_watermark_templates(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Instance-wide templates, visible to any authenticated user (for pickers)."""
    templates = db.query(WatermarkTemplate).filter(
        WatermarkTemplate.scope == WatermarkTemplateScope.instance,
        WatermarkTemplate.deleted_at.is_(None),
    ).order_by(WatermarkTemplate.created_at).all()
    return [WatermarkTemplateResponse.model_validate(t) for t in templates]


@router.post(
    "/watermark-templates",
    response_model=WatermarkTemplateResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_instance_watermark_template(
    body: WatermarkTemplateCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_superadmin(current_user)
    template = WatermarkTemplate(
        name=body.name,
        scope=WatermarkTemplateScope.instance,
        project_id=None,
        blocks=[b.model_dump() for b in body.blocks],
        created_by=current_user.id,
    )
    db.add(template)
    db.commit()
    db.refresh(template)
    return WatermarkTemplateResponse.model_validate(template)


@router.get(
    "/projects/{project_id}/watermark-templates",
    response_model=list[WatermarkTemplateResponse],
)
def list_project_watermark_templates(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Templates usable in a project: its own plus all instance-wide ones."""
    require_project_role(db, project_id, current_user, ProjectRole.viewer)
    templates = db.query(WatermarkTemplate).filter(
        WatermarkTemplate.deleted_at.is_(None),
        (WatermarkTemplate.project_id == project_id)
        | (WatermarkTemplate.scope == WatermarkTemplateScope.instance),
    ).order_by(WatermarkTemplate.created_at).all()
    return [WatermarkTemplateResponse.model_validate(t) for t in templates]


@router.post(
    "/projects/{project_id}/watermark-templates",
    response_model=WatermarkTemplateResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_project_watermark_template(
    project_id: uuid.UUID,
    body: WatermarkTemplateCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)
    template = WatermarkTemplate(
        name=body.name,
        scope=WatermarkTemplateScope.project,
        project_id=project_id,
        blocks=[b.model_dump() for b in body.blocks],
        created_by=current_user.id,
    )
    db.add(template)
    db.commit()
    db.refresh(template)
    return WatermarkTemplateResponse.model_validate(template)


@router.patch("/watermark-templates/{template_id}", response_model=WatermarkTemplateResponse)
def update_watermark_template(
    template_id: uuid.UUID,
    body: WatermarkTemplateUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    template = _get_template_or_404(db, template_id)
    _require_template_edit_access(db, template, current_user)
    if body.name is not None:
        template.name = body.name.strip()
    if body.blocks is not None:
        template.blocks = [b.model_dump() for b in body.blocks]
    db.commit()
    db.refresh(template)
    return WatermarkTemplateResponse.model_validate(template)


@router.delete("/watermark-templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_watermark_template(
    template_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    template = _get_template_or_404(db, template_id)
    _require_template_edit_access(db, template, current_user)
    template.deleted_at = datetime.now(timezone.utc)
    # Detach the template from any policies or share links that reference it
    db.query(WatermarkSettings).filter(
        WatermarkSettings.template_id == template_id
    ).update({WatermarkSettings.template_id: None})
    db.query(ShareLink).filter(
        ShareLink.watermark_template_id == template_id
    ).update({ShareLink.watermark_template_id: None})
    db.commit()


