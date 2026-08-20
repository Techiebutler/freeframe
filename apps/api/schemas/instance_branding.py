from datetime import datetime
from typing import Optional
from uuid import UUID
import re
from pydantic import BaseModel, field_validator

# \Z (not $) so a trailing newline can't sneak past and overflow the String(7) column.
HEX_COLOR_RE = r'^#[0-9A-Fa-f]{6}\Z'


def _validate_hex_color(v: Optional[str]) -> Optional[str]:
    if v is None:
        return v
    # Non-strings must raise ValueError, not TypeError — pydantic only wraps ValueError.
    if not isinstance(v, str) or not re.match(HEX_COLOR_RE, v):
        raise ValueError("Color must be a 6-digit hex value like '#7c3aed'")
    return v


class InstanceBrandingUpdate(BaseModel):
    org_name: Optional[str] = None

    @field_validator("org_name", mode="before")
    @classmethod
    def validate_org_name(cls, v):
        # Only runs when the caller actually sent org_name — an omitted field keeps
        # the default and stays out of model_dump(exclude_unset=True). An explicit
        # null would be written to the NOT NULL column, so reject it here.
        if v is None:
            raise ValueError("org_name cannot be null")
        if not isinstance(v, str):
            raise ValueError("org_name must be a string")
        v = v.strip()
        length = len(v)
        if length < 1 or length > 255:
            raise ValueError("org_name must be between 1 and 255 characters")
        return v
    logo_light_key: Optional[str] = None
    logo_dark_key: Optional[str] = None
    favicon_key: Optional[str] = None
    apple_icon_key: Optional[str] = None
    login_logo_key: Optional[str] = None
    primary_color: Optional[str] = None
    powered_by_freeframe: Optional[bool] = None

    @field_validator("primary_color", mode="before")
    @classmethod
    def validate_primary_color(cls, v):
        return _validate_hex_color(v)


class InstanceBrandingResponse(BaseModel):
    id: UUID
    org_name: str
    logo_light_key: Optional[str] = None
    logo_dark_key: Optional[str] = None
    favicon_key: Optional[str] = None
    apple_icon_key: Optional[str] = None
    login_logo_key: Optional[str] = None
    logo_light_url: Optional[str] = None
    logo_dark_url: Optional[str] = None
    favicon_url: Optional[str] = None
    apple_icon_url: Optional[str] = None
    login_logo_url: Optional[str] = None
    primary_color: Optional[str] = None
    powered_by_freeframe: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class InstanceBrandingLogoUploadResponse(BaseModel):
    upload_url: str
    key: str
