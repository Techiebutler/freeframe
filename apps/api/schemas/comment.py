from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator
import uuid
from datetime import datetime
from typing import Literal, Optional


class CommentSourceReference(BaseModel):
    """Public reference projection of H1 RequirementSource; never stores its quote."""
    model_config = {"extra": "forbid"}
    layer: Literal["basics", "brand", "briefing"]
    reference_id: str = Field(min_length=1, max_length=512)
    source_version: str = Field(min_length=1, max_length=512)


class ReviewSource(BaseModel):
    model_config = {"extra": "forbid"}
    schema_version: Literal["autoreview.comment-source.v1"]
    requirement_id: str = Field(min_length=1, max_length=512)
    plan_id: Optional[str] = Field(default=None, min_length=1, max_length=512)
    sources: list[CommentSourceReference] = Field(min_length=1, max_length=8)

    @field_validator("sources")
    @classmethod
    def unique_sources(cls, sources):
        return list({(s.layer, s.reference_id, s.source_version): s for s in sources}.values())


def public_review_source(value) -> Optional[dict]:
    if value is None:
        return None
    try:
        return ReviewSource.model_validate(value).model_dump(exclude_none=True)
    except ValidationError:
        return None


class HumanCommentPayload(BaseModel):
    @model_validator(mode="before")
    @classmethod
    def no_service_fields(cls, values):
        if isinstance(values, dict) and any(k in values for k in (
            "review_source", "review_publication_id", "review_publication_sha256", "publication_id",
        )):
            raise ValueError("Review provenance can only be set by the review bridge")
        return values

class AnnotationData(BaseModel):
    drawing_data: dict  # Fabric.js canvas JSON
    frame_number: Optional[int] = None
    carousel_position: Optional[int] = None

class CommentCreate(HumanCommentPayload):
    version_id: uuid.UUID
    parent_id: Optional[uuid.UUID] = None
    timecode_start: Optional[float] = None
    timecode_end: Optional[float] = None
    body: str
    visibility: Optional[str] = "public"  # "public" or "internal"
    annotation: Optional[AnnotationData] = None
    mention_user_ids: list[uuid.UUID] = []  # Explicit mention IDs from frontend
    attachments_expected: int = Field(default=0, ge=0, le=4)  # images that follow this comment

class GuestCommentCreate(HumanCommentPayload):
    idempotency_key: Optional[str] = Field(default=None, min_length=1, max_length=128)
    asset_id: Optional[uuid.UUID] = None  # Required for folder/project shares
    version_id: Optional[uuid.UUID] = None  # Auto-resolved if not provided
    parent_id: Optional[uuid.UUID] = None
    timecode_start: Optional[float] = None
    timecode_end: Optional[float] = None
    body: str
    annotation: Optional[AnnotationData] = None
    guest_email: Optional[str] = None  # Not needed if user is logged in
    guest_name: Optional[str] = None
    attachments_expected: int = Field(default=0, ge=0, le=4)  # images that follow this comment

class CommentUpdate(HumanCommentPayload):
    body: str


class ReviewCommentCreate(BaseModel):
    model_config = {"extra": "forbid"}
    asset_id: uuid.UUID
    version_id: uuid.UUID
    publication_id: uuid.UUID
    guest_email: str = Field(min_length=1, max_length=255)
    body: str = Field(min_length=1, max_length=20000)
    timecode_start: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)
    timecode_end: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)
    review_source: Optional[ReviewSource] = None

    @field_validator("guest_email")
    @classmethod
    def normalize_email(cls, value):
        return value.strip().lower()

class AnnotationResponse(BaseModel):
    id: uuid.UUID
    comment_id: uuid.UUID
    drawing_data: dict
    frame_number: Optional[int]
    carousel_position: Optional[int]
    model_config = {"from_attributes": True}

# ── Attachments ────────────────────────────────────────────────────────────────

class AttachmentUploadRequest(BaseModel):
    file_name: str = Field(min_length=1, max_length=200)
    file_size: int
    content_type: str
    guest_email: Optional[str] = None  # share route: the guest who wrote the comment

class AttachmentComplete(BaseModel):
    guest_email: Optional[str] = None  # share route: the guest who wrote the comment

class AttachmentUploadResponse(BaseModel):
    upload_url: str
    attachment_id: uuid.UUID
    key: str

class AttachmentResponse(BaseModel):
    id: uuid.UUID
    file_name: str
    file_size: int
    content_type: str
    url: str  # presigned S3 GET URL, generated at response time

# ── Reactions ──────────────────────────────────────────────────────────────────

class ReactionCreate(BaseModel):
    emoji: str

    @field_validator("emoji")
    @classmethod
    def emoji_max_length(cls, v: str) -> str:
        if len(v) > 10:
            raise ValueError("emoji must be at most 10 characters")
        return v

class ReactionResponse(BaseModel):
    emoji: str
    count: int
    reacted: bool  # whether the current user has reacted with this emoji

# ── Author info ────────────────────────────────────────────────────────────────

class AuthorInfo(BaseModel):
    id: uuid.UUID
    name: str
    avatar_url: Optional[str] = None

    @field_validator("avatar_url", mode="after")
    @classmethod
    def resolve_avatar_url(cls, v: Optional[str]) -> Optional[str]:
        if v and not v.startswith("http"):
            from ..services import s3_service
            return s3_service.generate_presigned_get_url(v)
        return v

class GuestAuthorInfo(BaseModel):
    id: uuid.UUID
    name: str
    email: str

# ── Comments ───────────────────────────────────────────────────────────────────

class CommentResponse(BaseModel):
    id: uuid.UUID
    asset_id: uuid.UUID
    version_id: uuid.UUID
    parent_id: Optional[uuid.UUID]
    author_id: Optional[uuid.UUID]
    guest_author_id: Optional[uuid.UUID]
    timecode_start: Optional[float]
    timecode_end: Optional[float]
    body: str
    resolved: bool
    visibility: str = "public"
    review_source: Optional[ReviewSource] = None
    created_at: datetime
    updated_at: datetime
    author: Optional[AuthorInfo] = None
    guest_author: Optional[GuestAuthorInfo] = None
    annotation: Optional[AnnotationResponse] = None
    replies: list["CommentResponse"] = []
    attachments: list[AttachmentResponse] = []
    reactions: list[ReactionResponse] = []
    model_config = {"from_attributes": True}

    @field_validator("review_source", mode="before")
    @classmethod
    def safe_source_projection(cls, value):
        # Old or unsupported data remains readable without claiming provenance.
        return public_review_source(value)

CommentResponse.model_rebuild()
