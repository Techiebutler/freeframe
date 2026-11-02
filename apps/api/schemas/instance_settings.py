from pydantic import BaseModel, Field, field_validator

from .upload import MAX_PART_SIZE_BYTES, MIN_PART_SIZE_BYTES, _format_bytes


class InstanceSettingsUpdate(BaseModel):
    # Upper bound = PostgreSQL BigInteger max (2**63 - 1); rejects overflow with 422 instead of a 500.
    storage_limit_bytes: int | None = Field(default=None, ge=0, le=9223372036854775807)
    # 0 sizes parts from each file; anything else is the fixed size every upload is cut on.
    upload_part_size_bytes: int | None = None
    # Lets share-link visitors, public-project visitors and direct shares download
    # originals. Project members always can.
    allow_original_downloads: bool | None = None
    # How hard review streams are compressed, 1 (highest quality) to 5
    # (smallest files). Unlike every other field here, an explicit null means
    # something: clear the stored level and follow `TRANSCODER_CRF_OFFSET`
    # again. Omitting the key still leaves it alone; the router tells the two
    # apart through `model_fields_set`.
    compression_level: int | None = None

    @field_validator("compression_level")
    @classmethod
    def validate_compression_level(cls, v):
        # The bounds come from the scale itself rather than being written out
        # again, so adding a step cannot leave the API rejecting it. In a
        # validator rather than `Field(ge=..., le=...)` so the transcoder
        # package is imported lazily, as everything else under `apps/api`
        # imports it.
        if v is None:
            return v
        from packages.transcoder.base import (
            MAX_COMPRESSION_LEVEL, MIN_COMPRESSION_LEVEL,
        )

        if not MIN_COMPRESSION_LEVEL <= v <= MAX_COMPRESSION_LEVEL:
            raise ValueError(
                f"Compression level must be between {MIN_COMPRESSION_LEVEL} "
                f"and {MAX_COMPRESSION_LEVEL}"
            )
        return v

    @field_validator("upload_part_size_bytes")
    @classmethod
    def validate_upload_part_size(cls, v):
        if v is None or v == 0:
            return v
        if not MIN_PART_SIZE_BYTES <= v <= MAX_PART_SIZE_BYTES:
            raise ValueError(
                f"Part size must be 0 (automatic) or between {_format_bytes(MIN_PART_SIZE_BYTES)} "
                f"and {_format_bytes(MAX_PART_SIZE_BYTES)}"
            )
        return v


class InstanceSettingsResponse(BaseModel):
    # Curated per role. Members and admins see the storage fields; admin-only
    # fields are left None for members rather than dumping the row.
    storage_limit_bytes: int
    storage_used_bytes: int
    # Admin only.
    upload_part_size_bytes: int | None = None
    allow_original_downloads: bool | None = None
    # Admin only, and null means something here: nobody has chosen a level, so
    # the transcoder is following TRANSCODER_CRF_OFFSET. The offset below says
    # what that works out to, so the slider can show where the instance sits.
    compression_level: int | None = None
    compression_crf_offset: int | None = None
    # Which step of the scale that effective offset is, resolved server-side
    # from the single scale in packages/transcoder/base.py, so the UI keeps no
    # copy of the offsets. Null means no step names the offset.
    compression_level_effective: int | None = None
