"""Agents (Claude Code, Codex, Hermes ...) as editors of one project, and the feedback rounds handed back to them."""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Index, JSON, String, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

try:
    from ..database import Base
except ImportError:
    from database import Base

PROGRAMS = ("claude-code", "codex", "chatgpt", "cursor", "hermes", "grok", "other")
SCOPES = ("read", "deliver")  # read: queue, review, feedback. deliver: read + upload, requests, ack, rule suggestions.


class AgentKey(Base):
    """Only sha256 of the key is stored. One row per (project, program, agent_name); re-pairing rotates it."""
    __tablename__ = "agent_keys"
    __table_args__ = (UniqueConstraint("project_id", "program", "agent_name", name="uq_agent_keys_project_program_name"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    program: Mapped[str] = mapped_column(String(20), nullable=False)
    agent_name: Mapped[str] = mapped_column(String(80), nullable=False)
    key_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    scope: Mapped[str] = mapped_column(String(10), nullable=False, default="deliver", server_default="deliver")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class AgentPairingCode(Base):
    __tablename__ = "agent_pairing_codes"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    code_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class FeedbackRound(Base):
    __tablename__ = "feedback_rounds"
    # One open round per request, enforced by the database.
    __table_args__ = (Index("uq_feedback_rounds_one_open", "request_id", unique=True, postgresql_where=text("closed_at IS NULL")),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("upload_requests.id"), nullable=False, index=True)
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    closed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_by: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)  # button | idle
    last_activity_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    acked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    rule_suggestions: Mapped[list] = mapped_column(JSON, nullable=False, default=list, server_default="[]")
