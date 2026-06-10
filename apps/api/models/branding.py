import uuid
from datetime import datetime
from enum import Enum as PyEnum
from typing import Optional
from sqlalchemy import String, Enum, DateTime, ForeignKey, Boolean, Float, func, JSON
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
try:
    from ..database import Base
except ImportError:
    from database import Base

class ViewerLayout(str, PyEnum):
    grid = "grid"
    reel = "reel"

class WatermarkPosition(str, PyEnum):
    center = "center"
    corner = "corner"
    tiled = "tiled"

class WatermarkContent(str, PyEnum):
    email = "email"
    name = "name"
    custom_text = "custom_text"

class WatermarkTemplateScope(str, PyEnum):
    instance = "instance"
    project = "project"

class ProjectBranding(Base):
    __tablename__ = "project_brandings"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), unique=True, nullable=False)
    logo_s3_key: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    primary_color: Mapped[Optional[str]] = mapped_column(String(7), nullable=True)
    secondary_color: Mapped[Optional[str]] = mapped_column(String(7), nullable=True)
    custom_title: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    custom_footer: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    viewer_layout: Mapped[ViewerLayout] = mapped_column(Enum(ViewerLayout), default=ViewerLayout.grid)
    featured_field: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

class WatermarkTemplate(Base):
    """A reusable watermark layout: a named collection of text blocks.

    Instance-scoped templates (project_id IS NULL) are shared across the whole
    deployment; project-scoped templates belong to a single project.
    """
    __tablename__ = "watermark_templates"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    scope: Mapped[WatermarkTemplateScope] = mapped_column(
        Enum(WatermarkTemplateScope), nullable=False, default=WatermarkTemplateScope.project
    )
    project_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id"), nullable=True, index=True
    )
    # List of block dicts: field, custom_text, x, y, size, color, opacity,
    # rotation, shadow, scroll, tiled (see schemas.branding.WatermarkBlock)
    blocks: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

class WatermarkSettings(Base):
    """Watermark policy.

    - project_id set, share_link_id NULL  -> project policy
    - project_id NULL, share_link_id NULL -> instance-wide defaults (superadmin)
    """
    __tablename__ = "watermark_settings"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=True)
    share_link_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("share_links.id"), nullable=True)
    # Legacy single-text fields (kept for backwards compatibility with the old API)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    position: Mapped[WatermarkPosition] = mapped_column(Enum(WatermarkPosition), default=WatermarkPosition.corner)
    content: Mapped[WatermarkContent] = mapped_column(Enum(WatermarkContent), default=WatermarkContent.email)
    custom_text: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    opacity: Mapped[float] = mapped_column(Float, default=0.3)
    # Policy fields
    require_internal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    require_shares: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    template_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("watermark_templates.id"), nullable=True
    )
    # Project roles that never see internal watermarks (matches Frame.io's
    # "admins and owners are exempt" default)
    exempt_roles: Mapped[list] = mapped_column(JSON, nullable=False, default=lambda: ["owner", "editor"])
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
