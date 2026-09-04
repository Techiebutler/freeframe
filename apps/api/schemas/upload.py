from typing import Literal
from pydantic import BaseModel, Field
import uuid
from ..models.asset import AssetType
from ..config import settings

ALLOWED_MIME_TYPES = {
    # Images
    "image/jpeg", "image/png", "image/webp", "image/heic", "image/tiff", "image/gif",
    # Audio
    "audio/mpeg", "audio/wav", "audio/flac", "audio/aac", "audio/ogg", "audio/x-m4a",
    # Video
    "video/mp4", "video/quicktime", "video/x-msvideo", "video/x-matroska",
    "video/webm", "video/mpeg", "video/x-ms-wmv",
}

# The part size every new upload is cut on. Returned by initiate and by the
# resume endpoint so the client never uses a constant of its own: a build whose
# idea of the chunk size differs from the one an upload was started with places
# its parts at the wrong byte ranges, which R2 rejects outright and which
# assembles a corrupt object anywhere that does not enforce uniform part sizes.
CHUNK_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB
# S3 allows at most 10,000 parts, so this is the largest object this scheme can
# assemble regardless of MAX_UPLOAD_BYTES. Declaring more than this is not a
# policy question, it is arithmetically impossible.
MAX_MULTIPART_BYTES = 10_000 * CHUNK_SIZE_BYTES

def _format_bytes(num_bytes: int) -> str:
    """Human-readable size for error messages, e.g. '10 GB'."""
    value = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{int(value)} {unit}" if value == int(value) else f"{value:.1f} {unit}"
        value /= 1024

def upload_size_error(file_size_bytes: int) -> str | None:
    """Return an error detail if the file exceeds the configured per-file cap, else None.

    ``settings.max_upload_bytes == 0`` disables the cap (unlimited). Read at call time
    so the limit stays configurable via the ``MAX_UPLOAD_BYTES`` env var.
    """
    limit = settings.max_upload_bytes
    if limit and file_size_bytes > limit:
        return f"File exceeds {_format_bytes(limit)} limit"
    return None

def mime_to_asset_type(mime_type: str) -> AssetType:
    if mime_type.startswith("image/"):
        return AssetType.image
    elif mime_type.startswith("audio/"):
        return AssetType.audio
    elif mime_type.startswith("video/"):
        return AssetType.video
    raise ValueError(f"Unsupported mime type: {mime_type}")

class InitiateUploadRequest(BaseModel):
    project_id: uuid.UUID
    asset_name: str
    original_filename: str
    mime_type: str
    # gt=0 because a zero or negative value otherwise reaches upload_guard_error
    # and the client's ceil(size / chunk) arithmetic, where it produces a part
    # count of zero and an upload that can never complete. The upper bound is the
    # structural ceiling of S3 multipart: 10,000 parts at the 10 MB chunk size.
    file_size_bytes: int = Field(gt=0, le=MAX_MULTIPART_BYTES)
    # For new version of existing asset
    asset_id: uuid.UUID | None = None
    folder_id: uuid.UUID | None = None

class InitiateUploadResponse(BaseModel):
    upload_id: str
    s3_key: str
    asset_id: uuid.UUID
    version_id: uuid.UUID
    chunk_size_bytes: int = CHUNK_SIZE_BYTES

class PresignPartRequest(BaseModel):
    s3_key: str
    upload_id: str
    part_number: int  # 1-indexed

class PresignPartResponse(BaseModel):
    presigned_url: str
    part_number: int

class UploadPart(BaseModel):
    PartNumber: int
    ETag: str

class CompleteUploadRequest(BaseModel):
    s3_key: str
    upload_id: str
    asset_id: uuid.UUID
    version_id: uuid.UUID
    # Only used on a backend that cannot list an upload's parts. Everywhere else
    # the server reads them from storage, because a client-supplied list that
    # omits a part completes successfully and truncates the file.
    parts: list[UploadPart] = []

class CompleteUploadResponse(BaseModel):
    status: str
    asset_id: uuid.UUID
    version_id: uuid.UUID

class AbortUploadRequest(BaseModel):
    s3_key: str
    upload_id: str
    version_id: uuid.UUID


class ResumeUploadResponse(BaseModel):
    """Everything needed to carry on an upload that stopped part-way.

    ``state`` is what the client should do next:

    - ``resumable`` -- the multipart upload is still open. Send the parts that
      are not in ``held_part_numbers`` and then complete as usual.
    - ``assembled`` -- the multipart upload is gone and a full-size object is
      sitting at the key, so CompleteMultipartUpload already ran and only the
      status write is outstanding. Nothing needs uploading; call
      ``/upload/complete``, which recognises this case and finishes the version.

    ``held_part_numbers`` is what the backend holds *at the size this upload cuts
    parts at*, not simply what it lists. Anything else is treated as absent and
    sent again, which is free: re-PUTting a part number into an open multipart
    upload replaces it.
    """
    state: Literal["resumable", "assembled"]
    upload_id: str
    s3_key: str
    asset_id: uuid.UUID
    version_id: uuid.UUID
    chunk_size_bytes: int
    file_size_bytes: int
    original_filename: str
    mime_type: str
    held_part_numbers: list[int]
