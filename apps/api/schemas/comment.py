from pydantic import BaseModel, field_validator
import uuid
from datetime import datetime
from typing import Optional

class AnnotationData(BaseModel):
    drawing_data: dict  # Fabric.js canvas JSON
    frame_number: Optional[int] = None
    carousel_position: Optional[int] = None

class CommentCreate(BaseModel):
    version_id: uuid.UUID
    parent_id: Optional[uuid.UUID] = None
    timecode_start: Optional[float] = None
    timecode_end: Optional[float] = None
    body: str
    visibility: Optional[str] = "public"  # "public" or "internal"
    annotation: Optional[AnnotationData] = None
    mention_user_ids: list[uuid.UUID] = []  # Explicit mention IDs from frontend

class GuestCommentCreate(BaseModel):
    version_id: uuid.UUID
    parent_id: Optional[uuid.UUID] = None
    timecode_start: Optional[float] = None
    timecode_end: Optional[float] = None
    body: str
    annotation: Optional[AnnotationData] = None
    guest_email: str
    guest_name: str

class CommentUpdate(BaseModel):
    body: str

class AnnotationResponse(BaseModel):
    id: uuid.UUID
    comment_id: uuid.UUID
    drawing_data: dict
    frame_number: Optional[int]
    carousel_position: Optional[int]
    model_config = {"from_attributes": True}

# ── Attachments ────────────────────────────────────────────────────────────────

class AttachmentUploadRequest(BaseModel):
    file_name: str
    file_size: int
    content_type: str

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
    created_at: datetime
    updated_at: datetime
    author: Optional[AuthorInfo] = None
    guest_author: Optional[GuestAuthorInfo] = None
    annotation: Optional[AnnotationResponse] = None
    replies: list["CommentResponse"] = []
    attachments: list[AttachmentResponse] = []
    reactions: list[ReactionResponse] = []
    model_config = {"from_attributes": True}

CommentResponse.model_rebuild()
