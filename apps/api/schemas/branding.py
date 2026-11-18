import re
from typing import Optional, Literal
from uuid import UUID
from pydantic import BaseModel, Field, field_validator


# \Z (not $) so a trailing newline can't sneak past and overflow the String(7) column.
HEX_COLOR_RE = re.compile(r'^#[0-9A-Fa-f]{6}\Z')


def _validate_hex_color(v: Optional[str]) -> Optional[str]:
    if v is None or v == "":
        return None
    # Non-strings must raise ValueError, not TypeError: pydantic only wraps ValueError.
    if not isinstance(v, str) or not HEX_COLOR_RE.match(v):
        raise ValueError("Color must be a 6-digit hex value like '#FF5733'")
    return v


# ── Branding ──────────────────────────────────────────────────────────────────

class BrandingUpdate(BaseModel):
    """A partial update: a field left out is unchanged, an explicit null clears it.

    Each max_length is the column's, so an over-long value is a 422 naming the
    field rather than a database error. Colours need none: the hex rule is
    stricter than their String(7) columns.
    """
    logo_s3_key: Optional[str] = Field(default=None, max_length=1000)
    primary_color: Optional[str] = None
    secondary_color: Optional[str] = None
    custom_title: Optional[str] = Field(default=None, max_length=255)
    custom_footer: Optional[str] = Field(default=None, max_length=500)
    viewer_layout: Optional[Literal["grid", "reel"]] = None
    featured_field: Optional[str] = Field(default=None, max_length=255)
    use_cover_as_logo: Optional[bool] = None

    @field_validator("primary_color", mode="before")
    @classmethod
    def validate_primary_color(cls, v):
        return _validate_hex_color(v)

    @field_validator("secondary_color", mode="before")
    @classmethod
    def validate_secondary_color(cls, v):
        return _validate_hex_color(v)

    @field_validator("custom_title", "custom_footer", "featured_field", mode="before")
    @classmethod
    def empty_text_clears(cls, v):
        return None if v == "" else v

    @field_validator("viewer_layout", "use_cover_as_logo", mode="before")
    @classmethod
    def not_null(cls, v, info):
        # These columns are NOT NULL. Leaving the field out keeps the stored
        # value; an explicit null has nothing to clear to.
        if v is None:
            raise ValueError(f"{info.field_name} cannot be null")
        return v


class BrandingResponse(BaseModel):
    id: UUID
    project_id: UUID
    logo_s3_key: Optional[str] = None
    logo_url: Optional[str] = None        # presigned GET URL, populated at response time
    primary_color: Optional[str] = None
    secondary_color: Optional[str] = None
    custom_title: Optional[str] = None
    custom_footer: Optional[str] = None
    viewer_layout: Optional[str] = None
    featured_field: Optional[str] = None
    use_cover_as_logo: bool = False

    model_config = {"from_attributes": True}


class BrandingLogoUploadResponse(BaseModel):
    upload_url: str
    key: str


# ── Watermark ─────────────────────────────────────────────────────────────────

class WatermarkUpdate(BaseModel):
    enabled: Optional[bool] = None
    position: Optional[Literal["center", "corner", "tiled"]] = None
    content: Optional[Literal["email", "name", "custom_text"]] = None
    custom_text: Optional[str] = None
    opacity: Optional[float] = None

    @field_validator("opacity", mode="before")
    @classmethod
    def validate_opacity(cls, v):
        if v is not None and not (0.0 <= v <= 1.0):
            raise ValueError("opacity must be between 0.0 and 1.0")
        return v


class WatermarkResponse(BaseModel):
    id: UUID
    project_id: UUID
    enabled: bool
    position: str
    content: str
    custom_text: Optional[str] = None
    opacity: float

    model_config = {"from_attributes": True}


class WatermarkImageUploadResponse(BaseModel):
    upload_url: str
    key: str
