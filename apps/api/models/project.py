import uuid
from datetime import datetime
from enum import Enum as PyEnum
from typing import Optional
from sqlalchemy import String, Boolean, Enum, DateTime, ForeignKey, func, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column
try:
    from ..database import Base
except ImportError:
    from database import Base

class ProjectType(str, PyEnum):
    personal = "personal"
    team = "team"

class ProjectRole(str, PyEnum):
    owner = "owner"
    editor = "editor"
    reviewer = "reviewer"
    viewer = "viewer"

class Project(Base):
    __tablename__ = "projects"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)
    project_type: Mapped[ProjectType] = mapped_column(Enum(ProjectType), default=ProjectType.personal)
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    poster_s3_key: Mapped[Optional[str]] = mapped_column(String(1024), nullable=True)
    is_public: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # A brand workspace - the project editors file hand-ins into. Only these show in the hand-in
    # dropdown; per-card junk projects stay false and are hidden there. See the 2026-09-15 cleanup.
    is_workspace: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # Explicit owner-confirmed identity for future staff assignments; never inferred or backfilled.
    review_brand_binding: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    # AutoReview Brand Loop: the review.aditor.ai brand this workspace's comments feed and its members
    # may open. Set explicitly by a superadmin; never inferred from the name, never backfilled.
    # Deliberately NOT unique: one brand can have several workspaces (audibene has more than one).
    autoreview_brand_slug: Mapped[Optional[str]] = mapped_column(String(120), nullable=True, index=True)
    # Agents may approve only when the owner says so; off by default.
    agents_may_approve: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

class ProjectMember(Base):
    __tablename__ = "project_members"
    __table_args__ = (UniqueConstraint("project_id", "user_id", name="uq_project_members_project_user"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    role: Mapped[ProjectRole] = mapped_column(Enum(ProjectRole), default=ProjectRole.viewer)
    invited_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    invited_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
