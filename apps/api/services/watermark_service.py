"""Watermark policy resolution.

Priority chain (highest wins): share link override > project policy >
instance-wide defaults. Internal viewers with an exempt project role never
see watermarks; share-link viewers always follow the share settings.
"""

import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import Request
from sqlalchemy.orm import Session

from ..config import settings
from ..models.asset import Asset, AssetType, AssetVersion, MediaFile
from ..models.branding import WatermarkSettings, WatermarkTemplate
from ..models.share import ShareLink
from ..models.user import User
from ..schemas.branding import WatermarkRender, WatermarkRenderBlock
from ..tasks.celery_app import send_task_safe
from ..tasks.watermark_tasks import render_watermark
from . import s3_service
from .permissions import get_project_member
from .redis_service import get_redis

# Used when a watermark is required but no template is configured anywhere.
FALLBACK_BLOCKS: list[dict] = [
    {
        "field": "email", "custom_text": None,
        "x": 50, "y": 50, "size": 4, "color": "#FFFFFF",
        "opacity": 0.35, "rotation": -30, "shadow": True,
        "scroll": False, "tiled": False,
    },
]

DISABLED = WatermarkRender(enabled=False, blocks=[])


def get_client_ip(request: Request) -> Optional[str]:
    """Viewer IP for watermark display. X-Real-Ip is set by the trusted
    reverse proxy (Traefik); X-Forwarded-For is avoided as it can be spoofed."""
    return request.headers.get("x-real-ip") or (
        request.client.host if request.client else None
    )


# ── Policy lookup ──────────────────────────────────────────────────────────────

def get_instance_policy(db: Session) -> Optional[WatermarkSettings]:
    return db.query(WatermarkSettings).filter(
        WatermarkSettings.project_id.is_(None),
        WatermarkSettings.share_link_id.is_(None),
    ).first()


def get_project_policy(db: Session, project_id: uuid.UUID) -> Optional[WatermarkSettings]:
    return db.query(WatermarkSettings).filter(
        WatermarkSettings.project_id == project_id,
        WatermarkSettings.share_link_id.is_(None),
    ).first()


def get_effective_policy(db: Session, project_id: uuid.UUID) -> Optional[WatermarkSettings]:
    """Project policy if one exists, otherwise the instance-wide defaults."""
    return get_project_policy(db, project_id) or get_instance_policy(db)


def get_template(db: Session, template_id: Optional[uuid.UUID]) -> Optional[WatermarkTemplate]:
    if not template_id:
        return None
    return db.query(WatermarkTemplate).filter(
        WatermarkTemplate.id == template_id,
        WatermarkTemplate.deleted_at.is_(None),
    ).first()


def _resolve_blocks(db: Session, *template_ids: Optional[uuid.UUID]) -> list[dict]:
    """Return blocks from the first existing template in the chain, else fallback."""
    for tid in template_ids:
        template = get_template(db, tid)
        if template and template.blocks:
            return template.blocks
    return FALLBACK_BLOCKS


# ── Rendering ──────────────────────────────────────────────────────────────────

def _render_blocks(
    blocks: list[dict],
    *,
    viewer_name: Optional[str],
    viewer_email: Optional[str],
    client_ip: Optional[str],
    share_name: Optional[str],
) -> list[WatermarkRenderBlock]:
    # Date only (no time) so the burn-in cache stays valid for a whole day
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    rendered = []
    for block in blocks:
        field = block.get("field", "custom_text")
        if field == "custom_text":
            text = block.get("custom_text") or ""
        elif field == "name":
            text = viewer_name or ""
        elif field == "email":
            text = viewer_email or ""
        elif field == "ip":
            text = client_ip or ""
        elif field == "date":
            text = now
        elif field == "share_name":
            text = share_name or ""
        else:
            text = ""
        if not text:
            continue
        rendered.append(WatermarkRenderBlock(
            text=text,
            x=float(block.get("x", 50)),
            y=float(block.get("y", 50)),
            size=float(block.get("size", 4)),
            color=block.get("color", "#FFFFFF"),
            opacity=float(block.get("opacity", 0.35)),
            rotation=float(block.get("rotation", 0)),
            shadow=bool(block.get("shadow", False)),
            scroll=bool(block.get("scroll", False)),
            tiled=bool(block.get("tiled", False)),
        ))
    return rendered


# ── Public API ─────────────────────────────────────────────────────────────────

def resolve_internal_watermark(
    db: Session,
    asset: Asset,
    user: User,
    client_ip: Optional[str] = None,
) -> WatermarkRender:
    """Watermark for an authenticated in-app viewer, or disabled if exempt."""
    policy = get_effective_policy(db, asset.project_id)
    if not policy or not policy.require_internal:
        return DISABLED

    member = get_project_member(db, asset.project_id, user.id)
    exempt_roles = policy.exempt_roles or []
    if member and member.role.value in exempt_roles:
        return DISABLED
    if user.is_superadmin:
        return DISABLED

    instance_policy = get_instance_policy(db)
    blocks = _resolve_blocks(
        db,
        policy.template_id,
        instance_policy.template_id if instance_policy else None,
    )
    rendered = _render_blocks(
        blocks,
        viewer_name=user.name or user.email,
        viewer_email=user.email,
        client_ip=client_ip,
        share_name=None,
    )
    return WatermarkRender(enabled=bool(rendered), blocks=rendered)


def resolve_share_watermark(
    db: Session,
    asset: Asset,
    link: ShareLink,
    user: Optional[User] = None,
    client_ip: Optional[str] = None,
) -> WatermarkRender:
    """Watermark for a share-link viewer.

    Applies when the share has watermarking on, or when the project/instance
    policy requires it on all shares (which locks the share toggle on).
    Anonymous viewers see the share name and creator in place of name/email,
    matching Frame.io's behavior.
    """
    policy = get_effective_policy(db, asset.project_id)
    required_by_policy = bool(policy and policy.require_shares)
    if not link.show_watermark and not required_by_policy:
        return DISABLED

    instance_policy = get_instance_policy(db)
    blocks = _resolve_blocks(
        db,
        link.watermark_template_id,
        policy.template_id if policy else None,
        instance_policy.template_id if instance_policy else None,
    )

    if user:
        viewer_name = user.name or user.email
        viewer_email = user.email
    else:
        creator = db.query(User).filter(User.id == link.created_by).first()
        viewer_name = link.title or "Shared link"
        viewer_email = (creator.email if creator else None) or ""

    rendered = _render_blocks(
        blocks,
        viewer_name=viewer_name,
        viewer_email=viewer_email,
        client_ip=client_ip,
        share_name=link.title or None,
    )
    return WatermarkRender(enabled=bool(rendered), blocks=rendered)


def watermark_signature(render: WatermarkRender) -> str:
    """Stable hash of a resolved watermark, used as the burn-in cache key."""
    payload = json.dumps(
        [b.model_dump() for b in render.blocks],
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


# ── Watermarked downloads ──────────────────────────────────────────────────────

_BURNIN_TYPES = {AssetType.video, AssetType.image}
_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
_JOB_DEDUP_TTL_SECONDS = 300


def burnin_supported(asset_type: AssetType) -> bool:
    """Visual burn-in only applies to video and still images."""
    return asset_type in _BURNIN_TYPES


def _burnin_output_ext(asset: Asset, media_file: MediaFile) -> str:
    if asset.asset_type == AssetType.video:
        return ".mp4"
    ext = (media_file.original_filename or "").lower()
    ext = ext[ext.rfind("."):] if "." in ext else ""
    if ext == ".jpeg":
        ext = ".jpg"
    return ext if ext in _IMAGE_EXTS else ".png"


def get_or_request_watermarked_download(
    db: Session,
    asset: Asset,
    version: AssetVersion,
    media_file: MediaFile,
    render: WatermarkRender,
) -> Optional[str]:
    """Return a presigned URL for the watermarked copy, or None if it is
    still being prepared (a burn-in job is queued at most once per cache key)."""
    ext = _burnin_output_ext(asset, media_file)
    signature = watermark_signature(render)
    out_key = f"watermarked/{asset.id}/{version.id}/{signature}{ext}"

    s3 = s3_service.get_s3_client()
    try:
        s3.head_object(Bucket=settings.s3_bucket, Key=out_key)
        filename = s3_service.build_download_filename(asset.name, out_key)
        return s3_service.generate_presigned_get_url(out_key, download_filename=filename)
    except Exception:
        pass  # not rendered yet

    # Queue the burn-in job, deduplicating across polling requests
    should_queue = True
    try:
        r = get_redis()
        should_queue = bool(r.set(f"wmjob:{out_key}", "1", nx=True, ex=_JOB_DEDUP_TTL_SECONDS))
    except Exception:
        pass  # Redis unavailable — queue anyway (task itself is idempotent)

    if should_queue:
        send_task_safe(
            render_watermark,
            str(asset.id),
            str(media_file.id),
            [b.model_dump() for b in render.blocks],
            out_key,
        )
    return None
