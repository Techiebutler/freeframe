"""Data and actions behind the admin Storage tab.

One question: what takes up space, and what to clear out. Every figure is one
number (originals plus measured derived output) and comes from
`services/storage.py`, so the header, the rows and the upload limit cannot
disagree. Nothing here hard-deletes except `purge_from_trash`:
`bulk_soft_delete` sets `deleted_at`, the same trash the rest of the app uses,
and the retention collector reclaims the bytes.
"""

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, or_, text
from sqlalchemy.orm import Session

from ..config import settings
from ..models.asset import Asset, AssetVersion, MediaFile, ProcessingStatus
from ..models.project import Project
from ..models.user import User
from . import storage as storage_service
from .versions import UNVIEWABLE_STATUSES
from .activity_service import log_activity
from .restore_rules import restore_asset_row, restore_version_row

log = logging.getLogger(__name__)

#: Above either of these a confirmation phrase has to be typed, in the UI and
#: again on the server. More than one project at a time is the shape of an
#: accident; ten gigabytes is the shape of one that hurts.
CONFIRM_ABOVE_PROJECTS = 1
CONFIRM_ABOVE_BYTES = 10 * 1024**3

#: Exactly this word, case included, which is the comparison the dialog makes
#: before it enables its button. The count used to be accepted too, and so did
#: the lowercase word, which cleared a gate whose own text asks for DELETE; a
#: gate that quietly accepts something its text does not ask for is a gate
#: people stop reading, and one the browser and the server disagree about is
#: worse than either.
CONFIRM_WORD = "DELETE"

_ACCEPTED = {CONFIRM_WORD}


class PanelGate(Exception):
    """A panel action that did not satisfy its gate.

    Carries the status the router answers with, so the rule lives next to the
    numbers it is about instead of being spelled out again in the endpoint.
    """

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


# Three names for one shape, kept apart so a router can catch only the gate it
# is about and a traceback says which action refused.
class DeleteGate(PanelGate):
    """A bulk delete that did not satisfy the confirmation gate."""


class RestoreGate(PanelGate):
    """A restore the retention window does not allow."""


class PurgeGate(PanelGate):
    """A purge that did not satisfy its confirmation gate."""


def retention_days() -> int:
    """The window a deleted thing stays restorable, as the collector reads it.

    Delegated to the collector's own `_retention_days` rather than read from
    the setting again here, so the API response and the pass that frees the
    bytes can never disagree about the number of days, including the clamp an
    absurd configured value gets. Imported lazily, as everything that reaches
    into `tasks` from this module is, to keep Celery out of the import path of
    a plain request.
    """
    from ..tasks.cleanup_tasks import _retention_days

    return _retention_days()


def _sum_bytes(query) -> int:
    """Originals plus measured derived bytes from one grouped-sum row."""
    row = query.one()
    return int(row.original_bytes) + int(row.derived_bytes)


#: The two sums, from `services/storage.py` rather than spelled out again here:
#: a second spelling of either one is a second definition of used storage, which
#: is the bug this whole change exists to close.
_byte_columns = storage_service.byte_columns


def _scoped_bytes(db: Session, scope, project_ids: list, asset_ids: list, version_ids: list) -> int:
    """Bytes under any of these roots, counted once each, within `scope`.

    One query, so a file reachable through two roots at once counts a single
    time. `scope` is `live_media` for a delete and `committed_media` for a
    purge, which is the only difference: a purge counts rows already trashed.
    """
    if not project_ids and not asset_ids and not version_ids:
        return 0
    scopes = []
    if project_ids:
        scopes.append(Asset.project_id.in_(project_ids))
    if asset_ids:
        scopes.append(Asset.id.in_(asset_ids))
    if version_ids:
        scopes.append(AssetVersion.id.in_(version_ids))
    return _sum_bytes(scope(db, *_byte_columns()).filter(or_(*scopes)))


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
    freed when it is deleted. `is_latest` marks the newest live version, which
    cannot be deleted on its own; see `check_gate`.
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


# ── Delete, trash, restore ────────────────────────────────────────────────────


def _resolve(
    db: Session,
    project_ids: list,
    asset_ids: list,
    version_ids: list,
    *,
    trashed: bool,
) -> dict:
    """Resolve a selection of ids into the rows they name, plus what is missing.

    `trashed` picks which side of `deleted_at` resolves: a delete works on live
    rows, a purge only on trashed ones. Either way an id resolving to nothing is
    reported in `missing`, never skipped: an action that quietly does less than
    it was asked to is the one surprise these surfaces cannot afford.
    """
    def state(model):
        return model.deleted_at.isnot(None) if trashed else model.deleted_at.is_(None)

    projects = (
        db.query(Project.id, Project.name)
        .filter(Project.id.in_(project_ids), state(Project)).all()
        if project_ids else []
    )
    assets = (
        db.query(Asset.id, Asset.name, Asset.project_id)
        .filter(Asset.id.in_(asset_ids), state(Asset)).all()
        if asset_ids else []
    )
    # A live selection needs its parent asset live too; the version query for a
    # purge deliberately does not constrain the parent, because a trashed
    # version inside a live asset is a purgeable root in its own right.
    version_filters = [AssetVersion.id.in_(version_ids), state(AssetVersion)]
    if not trashed:
        version_filters.append(Asset.deleted_at.is_(None))
    versions = (
        db.query(
            AssetVersion.id.label("id"),
            AssetVersion.version_number.label("version_number"),
            AssetVersion.asset_id.label("asset_id"),
            Asset.name.label("asset_name"),
            Asset.project_id.label("project_id"),
        )
        .join(Asset, AssetVersion.asset_id == Asset.id)
        .filter(*version_filters).all()
        if version_ids else []
    )

    found = {p.id for p in projects} | {a.id for a in assets} | {v.id for v in versions}
    return {
        "projects": [{"id": p.id, "name": p.name} for p in projects],
        "assets": [{"id": a.id, "name": a.name, "project_id": a.project_id} for a in assets],
        "versions": [
            {
                "id": v.id,
                "version_number": v.version_number,
                "asset_id": v.asset_id,
                "asset_name": v.asset_name,
                "project_id": v.project_id,
            }
            for v in versions
        ],
        "missing": [
            i for i in list(project_ids) + list(asset_ids) + list(version_ids) if i not in found
        ],
    }


def resolve_targets(
    db: Session,
    project_ids: list[uuid.UUID],
    asset_ids: list[uuid.UUID],
    version_ids: list[uuid.UUID] | None = None,
) -> dict:
    """What a live selection refers to, and what deleting it would free."""
    version_ids = list(version_ids or [])
    targets = _resolve(db, list(project_ids), list(asset_ids), version_ids, trashed=False)
    targets["bytes"] = selection_bytes(
        db,
        [p["id"] for p in targets["projects"]],
        [a["id"] for a in targets["assets"]],
        [v["id"] for v in targets["versions"]],
    )
    return targets


def selection_bytes(db: Session, project_ids: list, asset_ids: list, version_ids: list) -> int:
    """Originals plus measured derived bytes under any of these live roots."""
    return _scoped_bytes(db, storage_service.live_media, project_ids, asset_ids, version_ids)


def latest_version_ids(db: Session, asset_ids: list) -> dict:
    """The newest *showable* live version of each of these assets, by number.

    Same rule as `_display_version` in `routers/assets`: a `failed` or
    `uploading` version is the newest by number but not the one anybody sees,
    so with v1 ready, v2 ready and v3 failed the version this protects is v2.
    Counting v3 let a hand-made request take v2 on its own and quietly demote
    the file to v1, which is the whole harm the gate is about. Those two
    statuses are also outside `committed_media`, so the tab never lists them
    and the browser and the server read the same list.
    """
    if not asset_ids:
        return {}
    rows = (
        db.query(AssetVersion.asset_id, AssetVersion.id, AssetVersion.version_number)
        .filter(
            AssetVersion.asset_id.in_(asset_ids),
            AssetVersion.deleted_at.is_(None),
            AssetVersion.processing_status.notin_(UNVIEWABLE_STATUSES),
        )
        .all()
    )
    newest: dict = {}
    for asset_id, version_id, number in rows:
        current = newest.get(asset_id)
        if current is None or number > current[1]:
            newest[asset_id] = (version_id, number)
    # `_display_version` falls back to the newest live row if none is viewable.
    # Such an asset still needs the whole-file gate, including its only failed
    # or unfinished version.
    fallback_ids = set(asset_ids) - newest.keys()
    if fallback_ids:
        fallback = (
            db.query(AssetVersion.asset_id, AssetVersion.id, AssetVersion.version_number)
            .filter(AssetVersion.asset_id.in_(fallback_ids), AssetVersion.deleted_at.is_(None))
            .all()
        )
        for asset_id, version_id, number in fallback:
            current = newest.get(asset_id)
            if current is None or number > current[1]:
                newest[asset_id] = (version_id, number)
    return {asset_id: version_id for asset_id, (version_id, _) in newest.items()}


def needs_typed_confirmation(project_count: int, bytes_total: int) -> bool:
    """Does this selection have to be typed out before it runs?"""
    return project_count > CONFIRM_ABOVE_PROJECTS or bytes_total > CONFIRM_ABOVE_BYTES


def check_gate(db: Session, targets: dict, confirm_count: int, confirm_text: str | None) -> None:
    """Raise unless the request proved it meant this exact selection.

    Four checks, in the order that gives the most useful refusal:

    1. Everything selected still exists; deleting "whatever is left" of a stale
       page is not what was confirmed.
    2. The confirmed count matches the resolved count. The part the UI cannot be
       trusted with: without it a hand-made request deletes a different number
       of things than the dialog named.
    3. No asset's newest live version is taken alone, which would silently
       demote the asset to an older cut while reporting a tidy reclaim.
    4. Past a threshold the phrase was typed, enforced here and not only in the
       dialog, because a gate living in the browser is a suggestion.
    """
    if targets["missing"]:
        raise DeleteGate(
            409,
            f"{len(targets['missing'])} of the selected items no longer exist. "
            "Reload the list and select again.",
        )

    versions = targets.get("versions", [])
    resolved = len(targets["projects"]) + len(targets["assets"]) + len(versions)
    if resolved == 0:
        raise DeleteGate(400, "Nothing selected.")
    if confirm_count != resolved:
        raise DeleteGate(
            409,
            f"Confirmation is for {confirm_count} items but {resolved} are selected. "
            "Reload the list and select again.",
        )

    if versions:
        chosen_assets = {a["id"] for a in targets["assets"]}
        chosen_projects = {p["id"] for p in targets["projects"]}
        at_risk = [
            v for v in versions
            if v["asset_id"] not in chosen_assets and v["project_id"] not in chosen_projects
        ]
        newest = latest_version_ids(db, [v["asset_id"] for v in at_risk])
        blocked = [v for v in at_risk if newest.get(v["asset_id"]) == v["id"]]
        if blocked:
            names = ", ".join(sorted({v["asset_name"] for v in blocked}))
            raise DeleteGate(
                409,
                f"In this Storage tab, the newest version of {names} can only be deleted with the whole "
                "file. Select the file itself, or pick an older version.",
            )

    if needs_typed_confirmation(len(targets["projects"]), targets["bytes"]):
        if (confirm_text or "").strip() not in _ACCEPTED:
            raise DeleteGate(
                428, f"This deletes {resolved} {'item' if resolved == 1 else 'items'}. Type {CONFIRM_WORD} to confirm."
            )


def bulk_soft_delete(db: Session, targets: dict, actor: User) -> dict:
    """Move a confirmed selection into the trash and record that it happened.

    Soft delete only, so the worst a mistake here costs is the time to press
    Restore. One log entry for the action plus one per project, riding the same
    transaction as the deletes, so a rolled-back request logs nothing.
    """
    now = datetime.now(timezone.utc)
    project_ids = [p["id"] for p in targets["projects"]]
    asset_ids = [a["id"] for a in targets["assets"]]
    version_ids = [v["id"] for v in targets.get("versions", [])]

    for model, ids in ((Project, project_ids), (Asset, asset_ids), (AssetVersion, version_ids)):
        if ids:
            db.query(model).filter(
                model.id.in_(ids), model.deleted_at.is_(None)
            ).update({"deleted_at": now}, synchronize_session="fetch")

    days = retention_days()
    payload = {
        "via": "admin_panel",
        "projects": [str(i) for i in project_ids],
        "assets": [str(i) for i in asset_ids],
        "versions": [str(i) for i in version_ids],
        "count": len(project_ids) + len(asset_ids) + len(version_ids),
        "bytes": targets["bytes"],
        "retention_days": days,
        "typed_confirmation": needs_typed_confirmation(len(project_ids), targets["bytes"]),
    }
    log_activity(db, "admin_bulk_delete", user_id=actor.id, payload=payload)
    for pid in project_ids:
        log_activity(db, "admin_bulk_delete", user_id=actor.id, project_id=pid, payload=payload)
    for asset in targets["assets"]:
        log_activity(
            db, "admin_bulk_delete", user_id=actor.id,
            project_id=asset["project_id"], asset_id=asset["id"], payload=payload,
        )
    for version in targets.get("versions", []):
        log_activity(
            db, "admin_bulk_delete", user_id=actor.id,
            project_id=version["project_id"], asset_id=version["asset_id"], payload=payload,
        )

    return {
        "deleted_projects": len(project_ids),
        "deleted_assets": len(asset_ids),
        "deleted_versions": len(version_ids),
        "freed_bytes": targets["bytes"],
        "retention_days": days,
        "restorable_until": (now + timedelta(days=days)) if days > 0 else None,
    }


def _trash_root_bytes(db: Session) -> tuple[dict, dict, dict]:
    """What each purgeable root in the trash would free, by project, asset, version.

    A root is a trashed thing whose parents are all live. Only roots are priced:
    a trashed asset inside a trashed project is already counted on the project
    above it, and pricing it twice would make the rows add up to more than the
    trash holds. Three grouped queries, same committed definition as every other
    figure, so a row's number is what the summary drops by when it is purged.
    """
    total = func.coalesce(func.sum(MediaFile.file_size_bytes), 0) + \
        func.coalesce(func.sum(MediaFile.derived_size_bytes), 0)

    def priced(group_by, *filters):
        return dict(
            storage_service.committed_media(db, group_by, total)
            .filter(*filters).group_by(group_by).all()
        )

    return (
        priced(Asset.project_id, Project.deleted_at.isnot(None)),
        priced(Asset.id, Asset.deleted_at.isnot(None), Project.deleted_at.is_(None)),
        priced(
            AssetVersion.id,
            AssetVersion.deleted_at.isnot(None),
            Asset.deleted_at.is_(None),
            Project.deleted_at.is_(None),
        ),
    )


def trash_rows(db: Session) -> dict:
    """What is in the trash, how long it has left, and what it still costs.

    `days_left` counts down the collector's own window and is never negative;
    0 means the window is over, so the next pass takes the row and a restore
    answers 409. An asset or version that was never usable work is listed too,
    because it still has a row to remove, but the restore rule leaves it where
    it is (see `services/restore_rules`). `total_bytes` is what purging that one
    row frees, and None when
    a parent is trashed too: those bytes are the parent's figure, and a second
    number for the same bytes is how a list stops adding up.
    """
    days = retention_days()
    now = datetime.now(timezone.utc)
    project_bytes, asset_bytes, version_bytes = _trash_root_bytes(db)

    def left(deleted_at):
        if days <= 0 or deleted_at is None:
            # 0 disables the collector: nothing is on a clock, so there is no
            # number of days to report.
            return None
        remaining = (deleted_at + timedelta(days=days) - now).total_seconds()
        if remaining <= 0:
            return 0
        # Rounded up, not truncated. A thing deleted two days ago has 28 days
        # left, but the arithmetic lands a few microseconds short of 28 whole
        # days and truncation would report 27 and age everything by a day.
        return int(-(-remaining // 86400))

    projects = (
        db.query(Project.id, Project.name, Project.deleted_at)
        .filter(Project.deleted_at.isnot(None))
        .order_by(Project.deleted_at.desc())
        .all()
    )
    assets = (
        db.query(Asset.id, Asset.name, Asset.deleted_at, Project.id.label("project_id"),
                 Project.name.label("project_name"), Project.deleted_at.label("project_deleted_at"))
        .join(Project, Asset.project_id == Project.id)
        .filter(Asset.deleted_at.isnot(None))
        .order_by(Asset.deleted_at.desc())
        .all()
    )
    versions = (
        db.query(
            AssetVersion.id.label("version_id"),
            AssetVersion.version_number.label("version_number"),
            AssetVersion.deleted_at.label("deleted_at"),
            Asset.id.label("asset_id"),
            Asset.name.label("asset_name"),
            Asset.deleted_at.label("asset_deleted_at"),
            Project.id.label("project_id"),
            Project.name.label("project_name"),
            Project.deleted_at.label("project_deleted_at"),
        )
        .join(Asset, AssetVersion.asset_id == Asset.id)
        .join(Project, Asset.project_id == Project.id)
        .filter(AssetVersion.deleted_at.isnot(None))
        .order_by(AssetVersion.deleted_at.desc())
        .all()
    )

    return {
        "retention_days": days,
        "total_bytes": _trash_bytes(db),
        "projects": [
            {
                "project_id": p.id,
                "name": p.name,
                "deleted_at": p.deleted_at,
                "days_left": left(p.deleted_at),
                "total_bytes": int(project_bytes.get(p.id, 0)),
            }
            for p in projects
        ],
        "assets": [
            {
                "asset_id": a.id,
                "name": a.name,
                "project_id": a.project_id,
                "project_name": a.project_name,
                "deleted_at": a.deleted_at,
                "days_left": left(a.deleted_at),
                # An asset whose project is also deleted cannot come back on its
                # own; the project has to be restored first, and the row says so
                # instead of offering a button that answers 409.
                "blocked_by_project": a.project_deleted_at is not None,
                # Priced only while it is a root; inside a trashed project its
                # bytes are the project's figure.
                "total_bytes": (
                    None if a.project_deleted_at is not None else int(asset_bytes.get(a.id, 0))
                ),
            }
            for a in assets
        ],
        "versions": [
            {
                "version_id": v.version_id,
                "version_number": v.version_number,
                "asset_id": v.asset_id,
                "asset_name": v.asset_name,
                "project_id": v.project_id,
                "project_name": v.project_name,
                "deleted_at": v.deleted_at,
                "days_left": left(v.deleted_at),
                "blocked_by_parent": (
                    v.asset_deleted_at is not None or v.project_deleted_at is not None
                ),
                "total_bytes": (
                    None
                    if (v.asset_deleted_at is not None or v.project_deleted_at is not None)
                    else int(version_bytes.get(v.version_id, 0))
                ),
            }
            for v in versions
        ],
    }


def _outside_retention(db: Session, project_ids: list, asset_ids: list, version_ids: list) -> int:
    """How many of these were deleted longer ago than the window allows.

    Past the window a row belongs to the collector, and a restore the next pass
    undoes is worse than a refusal. The same cutoff the single-row endpoint
    uses: two doors into one operation with two rules makes the stricter one
    pointless. Retention 0 switches the collector off, so nothing is on a clock
    and the check does not apply.
    """
    days = retention_days()
    if days <= 0:
        return 0
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    stale = 0
    for model, ids in ((Project, project_ids), (Asset, asset_ids), (AssetVersion, version_ids)):
        if ids:
            stale += (
                db.query(func.count(model.id))
                .filter(model.id.in_(ids), model.deleted_at < cutoff)
                .scalar() or 0
            )
    return int(stale)


def restore(
    db: Session,
    project_ids: list[uuid.UUID],
    asset_ids: list[uuid.UUID],
    version_ids: list[uuid.UUID] | None = None,
    actor: User | None = None,
) -> dict:
    """Take things back out of the trash, and record that it happened.

    Clearing `deleted_at` is the whole operation; the collector re-checks and
    locks each row before cascading, so a restore racing a pass is already safe.
    Parents go before children, so a project with one of its assets and one of
    that asset's versions works in one go.

    Two rules before anything is written. The retention window applies to the
    whole request, not per row: a bulk restore covering less than it was asked
    to is the surprise the delete gate refuses. And what came back is logged as
    `admin_restore`, once for the action and once per project, because putting a
    project back in front of its members is as much an administrative reach as
    taking it away.

    Only what came back is reported and logged. An id the rule left in the
    trash is `skipped` and gets no log line: a record of an administrative reach
    has to record something that happened, or a project's history claims it was
    restored on a day nobody touched it.

    How a row comes back is not decided here. That is `services/restore_rules`,
    shared with `POST /assets/{id}/restore`: an asset whose folder is in the
    trash comes back at the project's root, and an upload that was never usable
    work does not come back at all. Two doors onto the same rows with two rules
    is how this panel restored an asset into a trashed folder, where nobody
    could reach it and the collector hard-deleted it.
    """
    version_ids = list(version_ids or [])
    stale = _outside_retention(db, list(project_ids), list(asset_ids), version_ids)
    if stale:
        raise RestoreGate(
            409,
            f"{stale} of the selected items were deleted more than {retention_days()} days ago "
            "and can no longer be restored.",
        )

    # Which ids this call really restores, settled before the update rather than
    # read back afterwards: afterwards a project that was never deleted looks
    # exactly like one this call brought back.
    restored_project_ids = [
        pid for (pid,) in db.query(Project.id).filter(
            Project.id.in_(project_ids), Project.deleted_at.isnot(None),
        ).all()
    ] if project_ids else []

    restored_projects = 0
    if restored_project_ids:
        restored_projects = db.query(Project).filter(
            Project.id.in_(restored_project_ids),
        ).update({"deleted_at": None}, synchronize_session="fetch")
        db.flush()

    blocked: list = []

    def restore_children(ids, parent_query, parent_fields, write) -> tuple[int, list]:
        """Restore row by row, skipping any whose parent is trashed.

        Restoring into a deleted parent would report success and then be
        hard-deleted with it, which is the same refusal the single-row restore
        endpoints already give.

        The write itself is `services/restore_rules`, the one rule those
        endpoints use: an asset whose folder is in the trash comes back at the
        project's root, and an upload that was never usable work does not come
        back at all. A row the rule leaves in the trash is not counted as
        restored, so the response cannot claim one.
        """
        done_count, done_ids = 0, []
        for row_id in ids:
            row = parent_query(row_id).first()
            if row is None:
                continue
            if any(getattr(row, f) is not None for f in parent_fields):
                blocked.append(row_id)
                continue
            if write(db, row_id):
                done_count += 1
                done_ids.append(row_id)
        if ids:
            db.flush()
        return done_count, done_ids

    restored_assets, restored_asset_ids = restore_children(
        asset_ids,
        lambda aid: (
            db.query(Asset.id, Project.deleted_at.label("project_deleted_at"))
            .join(Project, Asset.project_id == Project.id)
            .filter(Asset.id == aid, Asset.deleted_at.isnot(None))
        ),
        ("project_deleted_at",),
        restore_asset_row,
    )
    restored_versions, restored_version_ids = restore_children(
        version_ids,
        lambda vid: (
            db.query(
                AssetVersion.id,
                Asset.deleted_at.label("asset_deleted_at"),
                Project.deleted_at.label("project_deleted_at"),
            )
            .join(Asset, AssetVersion.asset_id == Asset.id)
            .join(Project, Asset.project_id == Project.id)
            .filter(AssetVersion.id == vid, AssetVersion.deleted_at.isnot(None))
        ),
        ("asset_deleted_at", "project_deleted_at"),
        restore_version_row,
    )

    # Asked for, not in the trash, not blocked by a parent either: nothing to do
    # and nothing done. Reported so a caller can see that its id did not take
    # effect, instead of reading a count and assuming it did.
    skipped = [
        str(i)
        for i in list(project_ids) + list(asset_ids) + version_ids
        if i not in restored_project_ids
        and i not in restored_asset_ids
        and i not in restored_version_ids
        and i not in blocked
    ]

    restored = {
        "restored_projects": int(restored_projects),
        "restored_assets": int(restored_assets),
        "restored_versions": int(restored_versions),
        "blocked_by_parent": [str(i) for i in blocked],
        "skipped": skipped,
    }

    # Nothing came back, nothing happened. A log line for an empty request would
    # bury the real ones exactly when somebody is reading the history to find
    # out who pulled a project out of the trash.
    total = sum(
        restored[k] for k in ("restored_projects", "restored_assets", "restored_versions")
    )
    if actor is not None and total > 0:
        payload = {
            "via": "admin_panel",
            "projects": [str(i) for i in restored_project_ids],
            "assets": [str(i) for i in restored_asset_ids],
            "versions": [str(i) for i in restored_version_ids],
            "count": total,
            "blocked_by_parent": restored["blocked_by_parent"],
            "skipped": skipped,
        }
        log_activity(db, "admin_restore", user_id=actor.id, payload=payload)
        for pid in restored_project_ids:
            log_activity(db, "admin_restore", user_id=actor.id, project_id=pid, payload=payload)

    return restored


# ── Emptying the trash for good ───────────────────────────────────────────────
#
# The one irreversible action in the panel. It exists because the 30-day window
# is a safety net, not a storage plan: when a disk is full today, waiting a
# month for the collector is not an answer.
#
# It reuses the retention collector's own cascade (`tasks/cleanup_tasks`), which
# already removes every S3 object; a parallel implementation here is the thing
# that would eventually stop matching it and leave objects behind. The only
# relaxation is the cutoff, `now` instead of the window. Rows that are *not* in
# the trash cannot be reached at all, which is why a delete goes through the
# trash first and this endpoint second.


def _still_being_written(db: Session, project_ids: list, asset_ids: list, version_ids: list) -> list:
    """Names of versions under this selection that a worker is still writing.

    The retention window used to keep the cascade away from running jobs: a
    version cannot be a month old and in flight. This endpoint removed the
    window, so a `processing` version can be reached while the transcoder is
    still writing under its prefix, which both loses the job and leaves the
    output it writes after the purge behind as orphans.

    An upload without its own deletion stamp may still be transferring under
    a trashed parent. Keep it while its activity is inside the reaper window.
    Explicitly discarded uploads can go. Processing jobs older than the stuck
    requeue window can go too: trashed rows are not redispatched by that sweep.
    A disabled sweep provides no age at which work is known to be abandoned.
    """
    if not project_ids and not asset_ids and not version_ids:
        return []
    scopes = []
    if project_ids:
        scopes.append(Asset.project_id.in_(project_ids))
    if asset_ids:
        scopes.append(Asset.id.in_(asset_ids))
    if version_ids:
        scopes.append(AssetVersion.id.in_(version_ids))
    rows = (
        db.query(Asset.name, AssetVersion)
        .join(Asset, AssetVersion.asset_id == Asset.id)
        .filter(
            or_(*scopes),
            AssetVersion.processing_status.in_((ProcessingStatus.processing, ProcessingStatus.uploading)),
        )
        .all()
    )
    now = datetime.now(timezone.utc)
    in_flight = set()
    for name, version in rows:
        if version.processing_status == ProcessingStatus.uploading:
            if version.deleted_at is not None:
                continue
            hours = settings.stale_upload_timeout_hours
        else:
            hours = settings.stuck_processing_timeout_hours
        activity = version.last_activity_at or version.created_at
        if activity.tzinfo is None:
            activity = activity.replace(tzinfo=timezone.utc)
        if hours <= 0 or activity >= now - timedelta(hours=hours):
            in_flight.add(f"{name} version {version.version_number}")
    return sorted(in_flight)


def trash_purge_targets(
    db: Session,
    project_ids: list[uuid.UUID],
    asset_ids: list[uuid.UUID],
    version_ids: list[uuid.UUID],
    everything: bool,
) -> dict:
    """What a purge would remove, resolved from the trash itself.

    Only rows carrying a `deleted_at` resolve; a live id comes back as missing,
    so "permanently delete this" can never be aimed at a project still in use by
    mistyping an id. `everything` reads the whole trash here rather than trusting
    the caller: the count and byte checks only mean something if the server
    decided what the figures describe.
    """
    if everything:
        project_ids, asset_ids, version_ids = (
            [r.id for r in db.query(model.id).filter(model.deleted_at.isnot(None)).all()]
            for model in (Project, Asset, AssetVersion)
        )

    targets = _resolve(db, list(project_ids), list(asset_ids), list(version_ids), trashed=True)
    resolved_projects = [p["id"] for p in targets["projects"]]
    resolved_assets = [a["id"] for a in targets["assets"]]
    resolved_versions = [v["id"] for v in targets["versions"]]
    # Measured now, before anything is removed: afterwards the rows the figure
    # is made of are gone and it could not be recomputed.
    targets["bytes"] = trash_selection_bytes(
        db, resolved_projects, resolved_assets, resolved_versions,
    )
    targets["in_flight"] = _still_being_written(
        db, resolved_projects, resolved_assets, resolved_versions,
    )
    return targets


def trash_selection_bytes(db, project_ids: list, asset_ids: list, version_ids: list) -> int:
    """Bytes held by these trashed roots, counted once each.

    Same committed-media definition as every other figure on the page, so the
    number the purge dialog shows is the number the storage summary drops by.
    Unlike `selection_bytes` this does not filter out soft-deleted rows: the
    whole point is that these are in the trash.
    """
    return _scoped_bytes(db, storage_service.committed_media, project_ids, asset_ids, version_ids)


def check_purge_gate(
    targets: dict,
    confirm_count: int,
    confirm_bytes: int,
    confirm_text: str | None,
) -> None:
    """Raise unless the request proved it meant this exact, irreversible purge.

    Stricter than `check_gate` on every axis, because nothing here comes back:
    both figures the dialog showed are echoed and checked (a count alone would
    let a selection change size in bytes without tripping anything), the phrase
    is required at **every** size, and anything named that is not in the trash
    is a refusal rather than a skip, which is what keeps a purge off a live
    project. A version a worker is still writing is refused too; the retention
    window used to make that impossible.
    """
    if targets["missing"]:
        raise PurgeGate(
            409,
            f"{len(targets['missing'])} of the selected items are not in the trash. "
            "Only things already deleted can be removed for good. Reload and try again.",
        )

    in_flight = targets.get("in_flight") or []
    if in_flight:
        raise PurgeGate(
            409,
            f"{', '.join(in_flight)} is still being processed. "
            "Wait for the job to finish, then try again.",
        )

    resolved = len(targets["projects"]) + len(targets["assets"]) + len(targets["versions"])
    if resolved == 0:
        raise PurgeGate(400, "The trash is empty.")
    if confirm_count != resolved:
        raise PurgeGate(
            409,
            f"Confirmation is for {confirm_count} items but {resolved} are in the trash. "
            "Reload and try again.",
        )
    if confirm_bytes != targets["bytes"]:
        raise PurgeGate(
            409,
            f"Confirmation is for {confirm_bytes} bytes but {targets['bytes']} would be "
            "removed. Reload and try again.",
        )
    if (confirm_text or "").strip() not in _ACCEPTED:
        raise PurgeGate(
            428,
            f"This cannot be undone. Type {CONFIRM_WORD} to permanently remove "
            f"{resolved} items.",
        )


def purge_from_trash(db: Session, targets: dict, actor: User) -> dict:
    """Hard-delete a confirmed selection of trashed things, right now.

    Runs the collector's own cascade per root, which removes the object-store
    keys as well as the rows. Three passes, in this order and for these reasons:

    1. Every root is re-read `FOR UPDATE` with a cutoff of `now`, so a restore
       committing after the resolve above is skipped rather than destroyed on a
       stale reading. Locking all of them first means what follows describes
       exactly what will cascade.
    2. The locked set is priced in one query, before anything is removed: a
       parent and its child are one `or_` branch and count once, and afterwards
       the rows the figure is made of are gone.
    3. Only then does the cascade run, and its object-store work is **collected,
       not done** (`PurgeCounts.deferred`): the caller commits the rows and then
       calls `reclaim_objects`. Deleting first meant a process dying partway
       left rows that `/admin/trash/restore` would bring back with their media
       already gone.

    A root that was restored in between is skipped, so it is neither priced nor
    logged; the figures are what happened, not what was asked for.

    Trashed **folders** are not roots here. The trash view does not list them,
    their own bytes are zero, and a trashed folder's assets are listed and
    purged in their own right; the empty folder rows are left for the retention
    collector, which has them in its own root list.

    The pass holds the collector's advisory lock, so a scheduled purge waits
    instead of cascading the same subtree twice. Mutates `db`; the caller
    commits.
    """
    from ..tasks import cleanup_tasks

    now = datetime.now(timezone.utc)
    # deferred=[] makes the cascade collect its object-store work instead of
    # doing it inside this request's transaction.
    counts = cleanup_tasks.PurgeCounts(retention_days=retention_days(), deferred=[])

    got_lock = db.execute(
        text("SELECT pg_try_advisory_xact_lock(:k)"),
        {"k": cleanup_tasks._PURGE_ADVISORY_LOCK_KEY},
    ).scalar()
    if got_lock is False:
        raise PurgeGate(409, "A cleanup pass is already running. Try again in a moment.")

    # Top down, matching `_purge_soft_deleted`: a project's cascade removes its
    # own assets and versions, so a later pass finds nothing left to do for them
    # rather than walking rows that are already gone.
    levels = (
        ("projects", Project, cleanup_tasks._purge_project),
        ("assets", Asset, cleanup_tasks._purge_asset),
        ("versions", AssetVersion, cleanup_tasks._purge_version),
    )
    cascading: dict = {key: [] for key, _, _ in levels}
    for key, model, _cascade in levels:
        for root in targets[key]:
            if cleanup_tasks._lock_if_still_purgeable(db, model, root["id"], now) is None:
                continue
            cascading[key].append(root)

    freed = trash_selection_bytes(
        db,
        [p["id"] for p in cascading["projects"]],
        [a["id"] for a in cascading["assets"]],
        [v["id"] for v in cascading["versions"]],
    )

    for key, _model, cascade in levels:
        for root in cascading[key]:
            cascade(db, root["id"], counts)
    db.flush()

    # project_id is left null on purpose. `_purge_project` deletes the activity
    # log of the project it removes, so an entry pinned to one of these projects
    # would be destroyed by the very action it records. The names are in the
    # payload because the rows that carry them are gone afterwards, and an id on
    # its own tells whoever reads this history nothing about what was destroyed.
    audit = log_activity(
        db,
        "admin_trash_purge",
        user_id=actor.id,
        payload={
            "via": "admin_panel",
            "projects": [{"id": str(p["id"]), "name": p["name"]} for p in cascading["projects"]],
            "assets": [{"id": str(a["id"]), "name": a["name"]} for a in cascading["assets"]],
            "versions": [
                {
                    "id": str(v["id"]),
                    "name": f"{v['asset_name']} version {v['version_number']}",
                }
                for v in cascading["versions"]
            ],
            "count": sum(len(cascading[key]) for key, _, _ in levels),
            "bytes": freed,
            # Filled in by `reclaim_objects`, once the store has answered.
            "s3_queued": len(counts.deferred or []),
            "at": now.isoformat(),
        },
    )

    return {
        "purged_projects": counts.projects,
        "purged_assets": counts.assets,
        "purged_versions": counts.versions,
        "freed_bytes": freed,
        # Both are 0 until the objects are really gone; nothing has been sent to
        # the store at this point.
        "s3_deletes": 0,
        "s3_failures": 0,
        "_counts": counts,
        "_audit": audit,
        "_actor_id": actor.id,
    }


def reclaim_objects(db: Session, pending: dict) -> dict:
    """Delete the objects a committed purge collected, and record what happened.

    Called by the endpoint **after** it has committed the row deletes, which is
    what makes a crash leak objects rather than strand restorable rows. The audit
    row is then amended with what the store actually did, so the one record of
    an irreversible reclaim says whether the bytes came back.
    """
    from ..tasks import cleanup_tasks

    counts = pending["_counts"]
    cleanup_tasks.run_deferred(counts)
    pending["s3_deletes"] = counts.s3_deletes
    pending["s3_failures"] = counts.s3_failures

    # WARNING, like the collector's own line: this is the only record of an
    # irreversible reclaim, and it has to survive a quiet log level.
    log.warning(
        "admin trash purge by user %s: %d project(s), %d asset(s), %d version(s), "
        "%d bytes, %d object-store reclaim(s), %d failed",
        pending["_actor_id"], counts.projects, counts.assets, counts.versions,
        pending["freed_bytes"], counts.s3_deletes, counts.s3_failures,
    )
    try:
        audit = pending["_audit"]
        payload = dict(audit.payload or {})
        payload.pop("s3_queued", None)
        payload["s3_deletes"] = counts.s3_deletes
        payload["s3_failures"] = counts.s3_failures
        audit.payload = payload
        db.commit()
    except Exception:  # the purge is already committed; an audit outage cannot undo it
        db.rollback()
        log.warning("admin trash purge audit could not be amended", exc_info=True)
    return pending
