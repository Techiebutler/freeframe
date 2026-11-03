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


# ── Delete, trash, restore ────────────────────────────────────────────────────


class AdminDeleteRequest(BaseModel):
    """A confirmed bulk delete.

    `confirm_count` is not a formality. The server resolves the selection itself
    and refuses when the two counts disagree, so a stale page or a hand-rolled
    request cannot delete a different number of things than were confirmed.

    `confirm_text` carries the typed phrase that a selection past the threshold
    needs (more than one project, or more than 10 GB). The server applies that
    threshold to its own figures; the dialog asking for it is a convenience, not
    the check.
    """
    project_ids: list[uuid.UUID] = Field(default_factory=list)
    asset_ids: list[uuid.UUID] = Field(default_factory=list)
    version_ids: list[uuid.UUID] = Field(default_factory=list)
    confirm_count: int
    confirm_text: str | None = None


class AdminDeleteResponse(BaseModel):
    deleted_projects: int
    deleted_assets: int
    deleted_versions: int
    freed_bytes: int
    retention_days: int
    #: When the retention collector may free these bytes for good. None when the
    #: collector is switched off (retention 0), where nothing is on a clock.
    restorable_until: datetime | None


class TrashProjectRow(BaseModel):
    project_id: uuid.UUID
    name: str
    deleted_at: datetime | None
    days_left: int | None
    #: What permanently deleting this one row would free. The per-row Delete
    #: permanently shows it and echoes it back, and the server checks it.
    total_bytes: int | None


class TrashAssetRow(BaseModel):
    asset_id: uuid.UUID
    name: str
    project_id: uuid.UUID
    project_name: str
    deleted_at: datetime | None
    days_left: int | None
    blocked_by_project: bool
    #: None while the project above it is in the trash: those bytes are counted
    #: on the project's row, and this one has no delete of its own to price.
    total_bytes: int | None


class TrashVersionRow(BaseModel):
    version_id: uuid.UUID
    version_number: int
    asset_id: uuid.UUID
    asset_name: str
    project_id: uuid.UUID
    project_name: str
    deleted_at: datetime | None
    days_left: int | None
    #: The asset or the project above it is in the trash too. Restoring this
    #: version alone would report a success and leave it just as unreachable, so
    #: the row says what has to come back first.
    blocked_by_parent: bool
    #: None while a parent is in the trash, for the reason above.
    total_bytes: int | None


class TrashResponse(BaseModel):
    retention_days: int
    #: What emptying the whole trash would free, the same figure the storage
    #: summary reports as `trash_bytes`.
    total_bytes: int
    projects: list[TrashProjectRow]
    assets: list[TrashAssetRow]
    versions: list[TrashVersionRow]


class AdminRestoreRequest(BaseModel):
    project_ids: list[uuid.UUID] = Field(default_factory=list)
    asset_ids: list[uuid.UUID] = Field(default_factory=list)
    version_ids: list[uuid.UUID] = Field(default_factory=list)


class AdminRestoreResponse(BaseModel):
    restored_projects: int
    restored_assets: int
    restored_versions: int
    #: Items whose project or asset is still deleted. They stay in the trash;
    #: restoring the thing above them first brings them within reach.
    blocked_by_parent: list[str]
    #: Ids the restore rule left where they were, so there was nothing to
    #: report: not in the trash at all, or an upload that was never usable work,
    #: whose objects were deleted before the row was stamped (the same rule
    #: `POST /assets/{id}/restore` applies, in `services/restore_rules`). They
    #: are reported rather than silently counted as done, and they leave no
    #: entry in the activity history, because nothing happened to them.
    skipped: list[str] = Field(default_factory=list)


# ── Emptying the trash for good ───────────────────────────────────────────────
#
# The only irreversible action in the panel, and the only one that frees bytes
# the moment it runs. Everything about it is deliberately harder than the rest:
# superadmin only, nothing but what is already in the trash, both figures from
# the dialog echoed back and checked against what the server resolves, and a
# typed phrase on top. A mismatch is a 409 rather than a best effort, because
# "delete roughly this much" is not a thing anyone can confirm.


class AdminPurgeRequest(BaseModel):
    """A confirmed permanent delete of things already in the trash.

    `everything` is the "empty the trash" button: the server resolves the whole
    trash itself rather than trusting a list a page assembled, which is what
    makes the count and byte checks below meaningful.

    `confirm_count` and `confirm_bytes` are the two figures the dialog showed.
    Both are checked against what the server resolved, so a page that has moved
    on, or a request put together by hand, cannot destroy a different amount
    than was confirmed.
    """
    project_ids: list[uuid.UUID] = Field(default_factory=list)
    asset_ids: list[uuid.UUID] = Field(default_factory=list)
    version_ids: list[uuid.UUID] = Field(default_factory=list)
    everything: bool = False
    confirm_count: int
    confirm_bytes: int
    #: Always required here, at every size. There is no restore afterwards.
    confirm_text: str | None = None


class AdminPurgeResponse(BaseModel):
    purged_projects: int
    purged_assets: int
    purged_versions: int
    #: Bytes the storage figures drop by, measured before the rows were removed.
    freed_bytes: int
    #: How many object-store deletes the cascade issued, originals, renditions
    #: and thumbnails alike. Reported because a reclaim that logged failures
    #: still removed the rows, and the two numbers are how that shows up.
    s3_deletes: int
