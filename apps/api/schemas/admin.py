import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class PurgeStartResponse(BaseModel):
    """Response for the async manual purge trigger."""
    status: str
    detail: str


class BackfillStartResponse(BaseModel):
    """Response for the async derived-size backfill trigger."""
    status: str
    detail: str


# ── Storage ───────────────────────────────────────────────────────────────────
#
# One figure per row: `total_bytes` is the originals plus the derived output
# that has been measured (renditions, HLS segments, the single-file download,
# poster thumbnails, audio waveforms). The originals/derived split stays in the
# database and in `services/storage.py`; a storage page answers how big a thing
# is, not how its bytes are apportioned.
#
# Not counted, because no row records their size: project posters, branding
# logos, avatars and comment attachments. `unmeasured_files` says how many
# committed files have never had their derived output measured, which is the
# only reason a total could be low; the overview reports it instead of
# presenting a figure it cannot stand behind.


class StorageSummary(BaseModel):
    used_bytes: int
    #: None when the instance has no storage limit configured. There is no
    #: capacity to read in that case, and the panel then says how much is used
    #: rather than inventing a denominator.
    capacity_bytes: int | None
    free_bytes: int | None
    unmeasured_files: int
    #: Bytes still held by things in the trash, not yet reclaimed.
    trash_bytes: int
    retention_days: int


class StorageProjectRow(BaseModel):
    project_id: uuid.UUID
    name: str
    total_bytes: int


class StorageOverviewResponse(BaseModel):
    summary: StorageSummary
    projects: list[StorageProjectRow]
    #: How many projects hold committed bytes in total. `projects` is the
    #: largest `limit` of them, so a truncated list can say so.
    project_count: int
    limit: int


class StorageVersionRow(BaseModel):
    version_id: uuid.UUID
    version_number: int
    total_bytes: int
    #: Whether this is the asset's newest live version. It can only be deleted
    #: together with the whole asset: taking it on its own would silently demote
    #: the asset to an older cut, which is not what ticking a line off a storage
    #: list means. The flag lets a caller say so before the request rather than
    #: after.
    is_latest: bool


class StorageAssetRow(BaseModel):
    asset_id: uuid.UUID
    name: str
    total_bytes: int
    versions: list[StorageVersionRow]


class StorageProjectFilesResponse(BaseModel):
    project_id: uuid.UUID
    name: str
    assets: list[StorageAssetRow]
