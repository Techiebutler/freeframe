import uuid
from datetime import datetime
from enum import Enum as PyEnum
from typing import Optional
from sqlalchemy import String, Enum, DateTime, JSON, func, Integer
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
try:
    from ..database import Base
except ImportError:
    from database import Base

class UserStatus(str, PyEnum):
    active = "active"
    deactivated = "deactivated"
    pending_invite = "pending_invite"
    pending_verification = "pending_verification"

class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    avatar_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    password_hash: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    status: Mapped[UserStatus] = mapped_column(Enum(UserStatus), default=UserStatus.active)
    is_superadmin: Mapped[bool] = mapped_column(default=False)
    # Staff vs customer (platform v2, 2026-09-28). INSTANCE_WIDE_PROJECT_ACCESS rests on "an account
    # means staff"; self-signup breaks that, so it is stated per account instead. Every account that
    # existed before, and every invite / directory / setup account, is staff (server default true).
    # Only a self-signed-up customer is created with False, and sees nothing but its own projects.
    is_staff: Mapped[bool] = mapped_column(default=True, server_default="true", nullable=False)
    # human | agent. Agents are editors of exactly one project (apps/api/models/agent.py).
    kind: Mapped[str] = mapped_column(String(10), default="human", server_default="human", nullable=False)
    suite_account_id: Mapped[Optional[str]] = mapped_column(String(255), unique=True, nullable=True)
    suite_brand_id: Mapped[Optional[str]] = mapped_column(String(255), unique=True, nullable=True)
    # Trusted Suite attestation; browser-editable preferences must never grant access.
    suite_campaign: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    email_verified: Mapped[bool] = mapped_column(default=False)
    invite_token: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    invite_token_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    preferences: Mapped[dict] = mapped_column(JSON, nullable=False, server_default='{}')
    token_version: Mapped[int] = mapped_column(Integer, server_default="1", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

class GuestUser(Base):
    __tablename__ = "guest_users"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
