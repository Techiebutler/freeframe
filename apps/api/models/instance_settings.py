import uuid
from datetime import datetime
from sqlalchemy import BigInteger, DateTime, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
try:
    from ..database import Base
except ImportError:
    from database import Base


class InstanceSettings(Base):
    """Single-row table holding instance-wide (deployment-level) settings.

    Singleton: exactly one row, created lazily via get_or_create in the router.
    storage_limit_bytes == 0 means unlimited (matches MAX_UPLOAD_BYTES).
    upload_part_size_bytes == 0 means parts are sized from each file (see part_size_for).
    """
    __tablename__ = "instance_settings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    storage_limit_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    upload_part_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
