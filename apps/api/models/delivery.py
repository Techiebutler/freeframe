"""What an approval hands on: one public, tokened page per approved version (`/d/<token>`, no login)."""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

try:
    from ..database import Base
except ImportError:
    from database import Base


class Delivery(Base):
    """Created by the approval, deleted by its undo (until the link is copied). `handed_on_at` is set when the
    reviewer copies the share link; from then on the request lives in the "Delivered" archive."""
    __tablename__ = "deliveries"
    __table_args__ = (UniqueConstraint("asset_id", "version_id", name="uq_deliveries_asset_version"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    token: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    request_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("upload_requests.id"), nullable=True, index=True)
    asset_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("assets.id"), nullable=False, index=True)
    version_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("asset_versions.id"), nullable=False)
    approved_by: Mapped[str] = mapped_column(String(255), nullable=False)
    approved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    handed_on_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    file_hashes: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)  # media_file_id -> sha256, filled on the first ?format=json
