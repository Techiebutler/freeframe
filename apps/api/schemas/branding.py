import re
from typing import Optional, Literal
from uuid import UUID
from pydantic import BaseModel, field_validator, model_validator


HEX_COLOR_RE = re.compile(r'^#[0-9A-Fa-f]{6}$')


def _validate_hex_color(v: Optional[str]) -> Optional[str]:
    if v is not None and not HEX_COLOR_RE.match(v):
        raise ValueError("Color must be a 6-digit hex value like '#FF5733'")
    return v


# ── Branding ──────────────────────────────────────────────────────────────────

class BrandingUpdate(BaseModel):
    logo_s3_key: Optional[str] = None
    primary_color: Optional[str] = None
    secondary_color: Optional[str] = None
    custom_title: Optional[str] = None
    custom_footer: Optional[str] = None
    viewer_layout: Optional[Literal["grid", "reel"]] = None
    featured_field: Optional[str] = None

    @field_validator("primary_color", mode="before")
    @classmethod
    def validate_primary_color(cls, v):
        return _validate_hex_color(v)

    @field_validator("secondary_color", mode="before")
    @classmethod
    def validate_secondary_color(cls, v):
        return _validate_hex_color(v)


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

    model_config = {"from_attributes": True}


class BrandingLogoUploadResponse(BaseModel):
    upload_url: str
    key: str


# ── Watermark ─────────────────────────────────────────────────────────────────

WatermarkField = Literal["custom_text", "name", "email", "ip", "date", "share_name"]


class WatermarkBlock(BaseModel):
    """One positioned text block inside a watermark template."""
    field: WatermarkField = "custom_text"
    custom_text: Optional[str] = None
    x: float = 50.0           # percent of frame width (block center)
    y: float = 50.0           # percent of frame height (block center)
    size: float = 4.0         # font size as percent of frame height
    color: str = "#FFFFFF"
    opacity: float = 0.35
    rotation: float = 0.0     # degrees, counter-clockwise
    shadow: bool = False
    scroll: bool = False      # horizontal drift across the frame
    tiled: bool = False       # repeat the block in a grid across the frame

    @field_validator("color", mode="before")
    @classmethod
    def validate_color(cls, v):
        return _validate_hex_color(v) or "#FFFFFF"

    @field_validator("opacity")
    @classmethod
    def validate_block_opacity(cls, v):
        if not (0.0 <= v <= 1.0):
            raise ValueError("opacity must be between 0.0 and 1.0")
        return v

    @field_validator("x", "y")
    @classmethod
    def validate_position(cls, v):
        if not (0.0 <= v <= 100.0):
            raise ValueError("x/y must be between 0 and 100")
        return v

    @field_validator("size")
    @classmethod
    def validate_size(cls, v):
        if not (0.5 <= v <= 50.0):
            raise ValueError("size must be between 0.5 and 50 (percent of frame height)")
        return v

    @field_validator("rotation")
    @classmethod
    def validate_rotation(cls, v):
        if not (-180.0 <= v <= 180.0):
            raise ValueError("rotation must be between -180 and 180 degrees")
        return v


class WatermarkTemplateCreate(BaseModel):
    name: str
    blocks: list[WatermarkBlock]

    @field_validator("name")
    @classmethod
    def validate_name(cls, v):
        v = v.strip()
        if not v:
            raise ValueError("name must not be empty")
        if len(v) > 255:
            raise ValueError("name must be at most 255 characters")
        return v

    @field_validator("blocks")
    @classmethod
    def validate_blocks(cls, v):
        if not v:
            raise ValueError("template must contain at least one block")
        if len(v) > 10:
            raise ValueError("template may contain at most 10 blocks")
        return v


class WatermarkTemplateUpdate(BaseModel):
    name: Optional[str] = None
    blocks: Optional[list[WatermarkBlock]] = None

    @field_validator("blocks")
    @classmethod
    def validate_blocks(cls, v):
        if v is not None:
            if not v:
                raise ValueError("template must contain at least one block")
            if len(v) > 10:
                raise ValueError("template may contain at most 10 blocks")
        return v


class WatermarkTemplateResponse(BaseModel):
    id: UUID
    name: str
    scope: str
    project_id: Optional[UUID] = None
    blocks: list[WatermarkBlock]

    model_config = {"from_attributes": True}


class WatermarkUpdate(BaseModel):
    # Legacy single-text fields
    enabled: Optional[bool] = None
    position: Optional[Literal["center", "corner", "tiled"]] = None
    content: Optional[Literal["email", "name", "custom_text"]] = None
    custom_text: Optional[str] = None
    opacity: Optional[float] = None
    # Policy fields
    require_internal: Optional[bool] = None
    require_shares: Optional[bool] = None
    template_id: Optional[UUID] = None
    exempt_roles: Optional[list[Literal["owner", "editor", "reviewer", "viewer"]]] = None

    @field_validator("opacity", mode="before")
    @classmethod
    def validate_opacity(cls, v):
        if v is not None and not (0.0 <= v <= 1.0):
            raise ValueError("opacity must be between 0.0 and 1.0")
        return v


class WatermarkResponse(BaseModel):
    id: UUID
    project_id: Optional[UUID] = None
    enabled: bool
    position: str
    content: str
    custom_text: Optional[str] = None
    opacity: float
    require_internal: bool
    require_shares: bool
    template_id: Optional[UUID] = None
    exempt_roles: list[str]

    model_config = {"from_attributes": True}


class WatermarkRenderBlock(BaseModel):
    """A resolved block: final display text plus styling, ready to render."""
    text: str
    x: float
    y: float
    size: float
    color: str
    opacity: float
    rotation: float
    shadow: bool
    scroll: bool
    tiled: bool


class WatermarkRender(BaseModel):
    """Resolved watermark payload returned with stream URLs."""
    enabled: bool
    blocks: list[WatermarkRenderBlock] = []


class WatermarkImageUploadResponse(BaseModel):
    upload_url: str
    key: str
