import uuid
from datetime import datetime
from enum import Enum as PyEnum
from typing import Optional
from sqlalchemy import String, Enum, DateTime, ForeignKey, Boolean, Float, func
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
    # Share pages show the project's cover image as their logo, in place of logo_s3_key.
    use_cover_as_logo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

class WatermarkSettings(Base):
    __tablename__ = "watermark_settings"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    share_link_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("share_links.id"), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    position: Mapped[WatermarkPosition] = mapped_column(Enum(WatermarkPosition), default=WatermarkPosition.corner)
    content: Mapped[WatermarkContent] = mapped_column(Enum(WatermarkContent), default=WatermarkContent.email)
    custom_text: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    opacity: Mapped[float] = mapped_column(Float, default=0.3)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
