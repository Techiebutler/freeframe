from datetime import datetime
from typing import Literal, Optional
from pydantic import BaseModel, Field
import uuid
from ..models.asset import AssetType
from ..config import settings

# The web client sends the browser's File.type verbatim, and browsers do not
# agree on a name for the same container: for a .wav Chromium reports
# audio/wav, Safari/WebKit audio/x-wav, and a .bwf comes in as audio/vnd.wave.
# Every spelling a browser can produce for a format we accept has to be here,
# or the upload is refused before a byte is sent (#484). The pipeline never
# reads this value (ffmpeg probes the bytes), so an alias costs nothing.
ALLOWED_MIME_TYPES = {
    # Images
    "image/jpeg", "image/png", "image/webp", "image/heic", "image/tiff", "image/gif",
    # Audio
    "audio/mpeg", "audio/aac", "audio/ogg",
    "audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave", "audio/x-pn-wav",
    "audio/aiff", "audio/x-aiff",
    "audio/flac", "audio/x-flac",
    "audio/x-m4a", "audio/mp4",
    # Video
    "video/mp4", "video/x-m4v", "video/quicktime",
    "video/x-msvideo", "video/avi",
    "video/x-matroska", "video/matroska",
    "video/webm", "video/mpeg", "video/x-ms-wmv",
}

# The part size every new upload is cut on. Returned by initiate and by the
# resume endpoint so the client never uses a constant of its own: a build whose
# idea of the chunk size differs from the one an upload was started with places
# its parts at the wrong byte ranges, which R2 rejects outright and which
# assembles a corrupt object anywhere that does not enforce uniform part sizes.
#
# This is the smallest part an automatic size picks, and the fallback for
# versions created before the size was recorded. New uploads are cut on
# part_size_for.
CHUNK_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB

_MIB = 1024 * 1024
# The smallest non-final part S3, R2 and B2 accept.
MIN_PART_SIZE_BYTES = 5 * _MIB
# The largest fixed size an admin may set. Every byte of a part is sent again
# when it fails, and it has to fit asset_versions.chunk_size_bytes (an Integer).
MAX_PART_SIZE_BYTES = 512 * _MIB
# S3 allows at most 10,000 parts per upload.
MAX_PARTS = 10_000

# Automatic sizing aims for about this many parts. Completing an upload costs
# something per part -- ListParts reads them all back, and on MinIO and Silo
# every part is its own file whose metadata CompleteMultipartUpload reads and
# moves, which on spinning or network storage is milliseconds each. 10,000
# parts there is minutes at "95%"; a few hundred is seconds. Far fewer would
# leave the browser's five parallel PUTs idle at the end of a transfer.
AUTO_TARGET_PARTS = 500
# Automatic sizing stops growing parts here and lets the count rise instead, so
# a retry or an interruption never costs more than this per part in flight.
AUTO_MAX_PART_SIZE_BYTES = 256 * _MIB

# The largest object this scheme can assemble at all, regardless of
# MAX_UPLOAD_BYTES or the part size setting: 10,000 parts at the largest size.
# Declaring more than this is not a policy question, it is arithmetically
# impossible. The limit the instance's part size setting allows is narrower,
# and is checked by part_count_error.
MAX_MULTIPART_BYTES = MAX_PARTS * MAX_PART_SIZE_BYTES


def part_size_for(file_size_bytes: int, configured_bytes: int) -> int:
    """The part size a new upload of `file_size_bytes` is cut on.

    `configured_bytes` is the instance setting: 0 sizes parts from the file,
    anything else is a fixed size and is used as it is. Automatic sizing keeps
    the 10 MB parts every upload used to get until a file would need more than
    AUTO_TARGET_PARTS of them, then grows the part (in whole MiB) to hold the
    count there, up to AUTO_MAX_PART_SIZE_BYTES.
    """
    if configured_bytes:
        return configured_bytes
    per_part = -(-file_size_bytes // AUTO_TARGET_PARTS)  # ceil
    whole_mib = -(-per_part // _MIB) * _MIB
    return min(max(CHUNK_SIZE_BYTES, whole_mib), AUTO_MAX_PART_SIZE_BYTES)


def part_count_error(file_size_bytes: int, part_size_bytes: int, *, fixed: bool) -> str | None:
    """Why a file this size cannot be uploaded in parts this size, or None.

    `fixed` says the size came from the admin's setting rather than from
    part_size_for, which changes what the person uploading can be told to do.
    """
    if -(-file_size_bytes // part_size_bytes) <= MAX_PARTS:
        return None
    largest = _format_bytes(MAX_PARTS * part_size_bytes)
    if fixed:
        return (
            f"File is larger than the {largest} this instance's "
            f"{_format_bytes(part_size_bytes)} upload part size allows. "
            "An admin can change the part size in Instance Settings."
        )
    return f"File is larger than the {largest} an upload can hold"

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
    # structural ceiling of S3 multipart: 10,000 parts at the largest part size.
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
    # A person pressing Discard, as opposed to an upload that gave up. The two
    # want different things left behind: a failure is worth seeing in the
    # version list, a discard is not -- it is a red "Failed" badge on a version
    # somebody deliberately threw away. Set, the upload is disposed of the way
    # the reaper disposes of a stale one, only now instead of in a day.
    discard: bool = False


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
    # When something last happened on this upload *before* this request, which
    # itself counts as activity and moves the stored value. The client reads it
    # before doing anything irreversible: a recent value means the transfer may
    # still be running somewhere else -- another tab, another device -- and a
    # discard or a second resume there would destroy it.
    last_activity_at: Optional[datetime] = None
    # The server's clock as it answers. A client compares `last_activity_at`
    # with a moment on its own clock -- when the user clicked Resume -- and a
    # server stamp and a local one are on clocks that need not agree. With this
    # it compares two durations instead, each read on one clock: how long ago
    # the upload last moved, by this field, and how long ago the click was, by
    # its own.
    server_time: Optional[datetime] = None
