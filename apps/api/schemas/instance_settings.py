from pydantic import BaseModel, Field, field_validator

from .upload import MAX_PART_SIZE_BYTES, MIN_PART_SIZE_BYTES, _format_bytes


class InstanceSettingsUpdate(BaseModel):
    # Upper bound = PostgreSQL BigInteger max (2**63 - 1); rejects overflow with 422 instead of a 500.
    storage_limit_bytes: int | None = Field(default=None, ge=0, le=9223372036854775807)
    # 0 sizes parts from each file; anything else is the fixed size every upload is cut on.
    upload_part_size_bytes: int | None = None

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
