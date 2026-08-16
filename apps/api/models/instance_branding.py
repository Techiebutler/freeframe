import uuid
from datetime import datetime
from typing import Optional
from sqlalchemy import String, Boolean, DateTime, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
try:
    from ..database import Base
except ImportError:
    from database import Base


class InstanceBranding(Base):
    __tablename__ = "instance_branding"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_name: Mapped[str] = mapped_column(String(255), nullable=False, server_default="FreeFrame")
    logo_light_key: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    logo_dark_key: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    favicon_key: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    apple_icon_key: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    login_logo_key: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    primary_color: Mapped[Optional[str]] = mapped_column(String(7), nullable=True)
    powered_by_freeframe: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
