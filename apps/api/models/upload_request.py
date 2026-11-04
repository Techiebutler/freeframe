"""A file request: Dropbox-style "request files", with the review built in (platform v2).

An owner creates one per hand-in they want: it gets its own folder and its own public token. The
editor who opens /r/<token> uploads without an account - the token is the permission, exactly as a
share link is for viewing. Every upload lands in the request's folder, so a second upload of the
same file name is the next VERSION of that asset, never a stray copy.

`review_share_token` is the standing comment+download link Auto Review reads the folder through.
"""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, Text, func, text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column

try:
    from ..database import Base
except ImportError:
    from database import Base


class UploadRequest(Base):
    __tablename__ = "upload_requests"
    # An agent files a card under its own ref ("gen:<card_id>"); one request per (project, ref).
    __table_args__ = (Index("uq_upload_requests_project_external_ref", "project_id", "external_ref", unique=True,
                            postgresql_where=text("external_ref IS NOT NULL")),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    token: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    folder_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("folders.id"), nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    external_ref: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    brand_slug: Mapped[str] = mapped_column(String(120), nullable=False, server_default="")
    review_share_token: Mapped[str] = mapped_column(String(64), nullable=False)
    brief_excerpt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    timing_run_purpose: Mapped[Optional[dict]] = mapped_column(JSONB(none_as_null=True), nullable=True)
    timing_natural_intent: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    receive_iterations: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    iteration_manifest: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    iteration_state: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    iteration_mode: Mapped[str] = mapped_column(String(20), nullable=False, default="components", server_default="components")
    iteration_ratio: Mapped[str] = mapped_column(String(5), nullable=False, default="9:16", server_default="9:16")
    iteration_brief: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    iteration_lease_token: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    iteration_lease_until: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    iteration_owner_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    last_uploader_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    last_uploader_email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    # A new file reopens a finished request and clears completed_at; this keeps that it already finished once.
    first_completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    completion_versions: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RequestUpload(Base):
    """Who handed in which version through a request link - the one fact a share token cannot carry,
    and what the owner ranks their editors by (/insights/editors)."""
    __tablename__ = "request_uploads"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("upload_requests.id"), nullable=False, index=True)
    asset_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("assets.id"), nullable=False, index=True)
    version_number: Mapped[int] = mapped_column(nullable=False)
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    timing_provenance: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    uploader_name: Mapped[str] = mapped_column(String(255), nullable=False)
    uploader_email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
