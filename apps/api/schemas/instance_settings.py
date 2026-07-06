from pydantic import BaseModel, Field


class InstanceSettingsUpdate(BaseModel):
    storage_limit_bytes: int | None = Field(default=None, ge=0)


class InstanceSettingsResponse(BaseModel):
    # Curated per role. Today member and admin see the same fields; future admin-only
    # fields must be excluded from the member response rather than dumping the row.
    storage_limit_bytes: int
    storage_used_bytes: int
