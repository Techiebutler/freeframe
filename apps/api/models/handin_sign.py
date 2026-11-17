"""V3 part C (spec 2026-11-17 client delivery): an agent prepares a hand-in, a signed-in staff member signs it.

`prepared` = the agent's draft with a one-time sign link (only the token's hash is kept, 24 h). `signed` = a person
pressed Sign and send: `signed_by`/`signed_at` are set and the clean client link exists (`share_token`). An agent
never signs. Sending the link to the client stays a person's job.
"""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

try:
    from ..database import Base
except ImportError:
    from database import Base


class HandinSign(Base):
    __tablename__ = "handin_signs"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("upload_requests.id"), nullable=False, index=True)
    asset_ids: Mapped[list] = mapped_column(JSONB, nullable=False)
    client_text: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    prepared_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    prepared_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    signed_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    signed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    share_token: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    # The signer's drawn initials (a PNG data URL) and the brand rules they ticked "I've read this" for (V3 C follow-up):
    # whoever signs with a known violation forfeits the card's fee, so what they were shown is kept with the signature.
    initials_png: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    terms: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
