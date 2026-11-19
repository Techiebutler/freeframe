import uuid
from datetime import datetime
from enum import Enum as PyEnum
from typing import Optional
from sqlalchemy import String, Enum, DateTime, ForeignKey, func, Text, Index, CheckConstraint, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
try:
    from ..database import Base
except ImportError:
    from database import Base

class ApprovalStatus(str, PyEnum):
    approved = "approved"
    rejected = "rejected"
    # Never written by verdict code. Kept because a Postgres enum cannot lose a value
    # without rewriting the type, and rows written before verdicts may still hold it.
    pending = "pending"
    changes_requested = "changes_requested"

class Approval(Base):
    """One person's verdict on one version of an asset.

    The actor is either a signed-in user or a guest, never both and never neither:
    `ck_approvals_one_actor`. Uniqueness is per actor kind, so a version holds at
    most one verdict from each user and one from each guest.
    """
    __tablename__ = "approvals"
    __table_args__ = (
        CheckConstraint("(user_id IS NOT NULL) <> (guest_user_id IS NOT NULL)", name="ck_approvals_one_actor"),
        Index(
            "uq_approvals_version_user_live", "version_id", "user_id",
            unique=True, postgresql_where=text("user_id IS NOT NULL"),
        ),
        Index(
            "uq_approvals_version_guest", "version_id", "guest_user_id",
            unique=True, postgresql_where=text("guest_user_id IS NOT NULL"),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    asset_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("assets.id"), nullable=False, index=True)
    version_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("asset_versions.id"), nullable=False, index=True)
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True, index=True)
    guest_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("guest_users.id"), nullable=True, index=True)
    # The share link the verdict came through. SET NULL, not CASCADE: a client's
    # sign-off outlives the link it was given on.
    share_link_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("share_links.id", ondelete="SET NULL"), nullable=True, index=True)
    # The link's title when the verdict was written, so the team can still read where
    # it came from after the link is revoked or purged.
    via_link_title: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    status: Mapped[ApprovalStatus] = mapped_column(Enum(ApprovalStatus), default=ApprovalStatus.pending)
    note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
