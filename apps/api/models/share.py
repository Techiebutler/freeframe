import uuid
from datetime import datetime
from enum import Enum as PyEnum
from typing import Optional
from sqlalchemy import String, Enum, DateTime, ForeignKey, Boolean, func, Text, Index, JSON, CheckConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
try:
    from ..database import Base
except ImportError:
    from database import Base

class SharePermission(str, PyEnum):
    view = "view"
    comment = "comment"
    approve = "approve"

class ShareLink(Base):
    __tablename__ = "share_links"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    asset_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("assets.id"), nullable=True, index=True)
    folder_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("folders.id"), nullable=True, index=True)
    token: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False, server_default="")
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    password_hash: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    permission: Mapped[SharePermission] = mapped_column(Enum(SharePermission), default=SharePermission.view)
    allow_download: Mapped[bool] = mapped_column(Boolean, default=False)
    show_versions: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    show_watermark: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    appearance: Mapped[dict] = mapped_column(JSON, nullable=False, server_default='{"layout":"grid","theme":"dark","accent_color":null,"open_in_viewer":true,"sort_by":"created_at"}')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "(asset_id IS NOT NULL AND folder_id IS NULL) OR (asset_id IS NULL AND folder_id IS NOT NULL)",
            name="ck_share_link_asset_or_folder"
        ),
    )

class AssetShare(Base):
    __tablename__ = "asset_shares"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    asset_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("assets.id"), nullable=True, index=True)
    folder_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("folders.id"), nullable=True, index=True)
    shared_with_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    shared_with_team_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    permission: Mapped[SharePermission] = mapped_column(Enum(SharePermission), default=SharePermission.view)
    shared_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "(asset_id IS NOT NULL AND folder_id IS NULL) OR (asset_id IS NULL AND folder_id IS NOT NULL)",
            name="ck_asset_share_asset_or_folder"
        ),
    )

class ShareActivityAction(str, PyEnum):
    opened = "opened"
    viewed_asset = "viewed_asset"
    commented = "commented"
    approved = "approved"
    rejected = "rejected"
    downloaded = "downloaded"

class ShareLinkActivity(Base):
    __tablename__ = "share_link_activity"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    share_link_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("share_links.id"), nullable=False, index=True)
    action: Mapped[ShareActivityAction] = mapped_column(Enum(ShareActivityAction), nullable=False)
    actor_email: Mapped[str] = mapped_column(String(255), nullable=False)
    actor_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    asset_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    asset_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_share_activity_link_created", "share_link_id", "created_at"),
    )
