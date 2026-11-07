"""Data behind the admin storage overview.

One question: what takes up space. Every figure is one number (originals plus
measured derived output) and comes from `services/storage.py`, so the summary,
the rows and the upload limit cannot disagree. Nothing here writes.
"""

import uuid

from sqlalchemy.orm import Session

from ..config import settings
from ..models.asset import Asset, AssetVersion
from ..models.project import Project
from . import storage as storage_service


def retention_days() -> int:
    """The window a deleted thing stays restorable, as configured.

    Read from the existing setting rather than written down again here, so the
    API response and the collector that frees the bytes can never disagree
    about the number of days.
    """
    return settings.soft_delete_retention_days


def _sum_bytes(query) -> int:
    """Originals plus measured derived bytes from one grouped-sum row."""
    row = query.one()
    return int(row.original_bytes) + int(row.derived_bytes)


#: The two sums, from `services/storage.py` rather than spelled out again here:
#: a second spelling of either one is a second definition of used storage, which
#: is the bug this whole change exists to close.
_byte_columns = storage_service.byte_columns


# ── Storage ───────────────────────────────────────────────────────────────────


def _trash_bytes(db: Session) -> int:
    """The part of the used figure that is in the trash.

    A subset of `used_bytes`, not a second total beside it: the bytes of a
    deleted project are still in the bucket and still blocked by the limit. One
    `or_` branch, so a trashed project holding a trashed asset counts once.
    """
    return _sum_bytes(storage_service.trashed_media(db, *_byte_columns()))


def storage_summary(db: Session) -> dict:
    """Used, capacity, free, and how much of that is in the trash.

    `used_bytes` comes from `instance_storage_totals`, the same call the upload
    guard blocks on, so the summary and the limit cannot disagree; the figure
    used to report a deleted project's space as free while the next upload was
    refused. `trash_bytes` is the part of used that emptying the trash frees,
    which is why it reads "of which". `capacity_bytes` is None without a
    configured limit, rather than inventing a denominator.
    """
    totals = storage_service.instance_storage_totals(db)
    used = totals["used_bytes"]
    limit = storage_service.get_storage_limit(db)
    return {
        "used_bytes": used,
        "capacity_bytes": limit or None,
        "free_bytes": max(0, limit - used) if limit else None,
        # How many committed files have no derived measurement yet, so a figure
        # that is still incomplete says so instead of looking final.
        "unmeasured_files": totals["unmeasured_files"],
        "trash_bytes": _trash_bytes(db),
        "retention_days": retention_days(),
    }


def storage_project_rows(db: Session, limit: int) -> tuple[list[dict], int]:
    """Live projects holding committed bytes, largest first, and how many there are.

    A project soft-deleted between the two queries has no name here and is
    dropped: it is in the trash, which is the same answer the rest of the app
    gives.
    """
    rows = storage_service.project_storage_rows(db)
    total = len(rows)
    rows = rows[:limit]
    if not rows:
        return [], total

    names = dict(
        db.query(Project.id, Project.name)
        .filter(Project.id.in_([r["project_id"] for r in rows]), Project.deleted_at.is_(None))
        .all()
    )
    out = [
        {"project_id": r["project_id"], "name": names[r["project_id"]], "total_bytes": r["total_bytes"]}
        for r in rows
        if r["project_id"] in names
    ]
    return out, total


def storage_asset_rows(db: Session, project_id: uuid.UUID) -> list[dict]:
    """One project's files, largest first, each with its versions.

    Two levels and no more: everything under a version (renditions, HLS
    segments, the poster) is machine output nobody picks off a list. A row's
    size is everything it costs, transcode output included, which is what gets
    freed when it is deleted. `is_latest` marks the newest live version.
    """
    rows = (
        storage_service.live_media(
            db,
            Asset.id.label("asset_id"),
            Asset.name.label("asset_name"),
            AssetVersion.id.label("version_id"),
            AssetVersion.version_number.label("version_number"),
            *_byte_columns(),
        )
        .filter(Asset.project_id == project_id)
        .group_by(Asset.id, Asset.name, AssetVersion.id, AssetVersion.version_number)
        .all()
    )

    assets: dict = {}
    for r in rows:
        asset = assets.setdefault(
            r.asset_id,
            {"asset_id": r.asset_id, "name": r.asset_name, "total_bytes": 0, "versions": []},
        )
        total = int(r.original_bytes) + int(r.derived_bytes)
        asset["total_bytes"] += total
        asset["versions"].append({
            "version_id": r.version_id,
            "version_number": r.version_number,
            "total_bytes": total,
            "is_latest": False,
        })

    out = list(assets.values())
    for asset in out:
        # Newest by version number, not by size: "latest" is which cut is
        # current, and sorting by bytes would crown whichever transcoded largest.
        asset["versions"].sort(key=lambda v: v["version_number"], reverse=True)
        if asset["versions"]:
            asset["versions"][0]["is_latest"] = True
    out.sort(key=lambda r: r["total_bytes"], reverse=True)
    return out
