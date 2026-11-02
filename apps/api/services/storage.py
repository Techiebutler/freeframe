from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from ..models.asset import Asset, AssetVersion, MediaFile, ProcessingStatus
from ..models.instance_settings import InstanceSettings
from ..models.project import Project
from ..schemas.upload import _format_bytes, part_count_error, part_size_for, upload_size_error


def get_storage_limit(db: Session) -> int:
    """Non-creating read of the instance storage cap. 0 (or no row) == unlimited."""
    row = db.query(InstanceSettings).first()
    return row.storage_limit_bytes if row else 0


def get_upload_part_size(db: Session) -> int:
    """Non-creating read of the upload part size setting. 0 (or no row) == automatic."""
    row = db.query(InstanceSettings).first()
    return row.upload_part_size_bytes if row else 0


def get_allow_original_downloads(db: Session) -> bool:
    """Non-creating read: may people outside a project download originals? No row == no."""
    row = db.query(InstanceSettings).first()
    return bool(row.allow_original_downloads) if row else False


def choose_part_size(db: Session, file_size_bytes: int) -> tuple[int, str | None]:
    """The part size a new upload is cut on, and why it cannot be uploaded at all
    (a fixed size too small for 10,000 parts to hold the file), or None."""
    configured = get_upload_part_size(db)
    part_size = part_size_for(file_size_bytes, configured)
    return part_size, part_count_error(file_size_bytes, part_size, fixed=bool(configured))


def instance_storage_used_bytes(db: Session) -> int:
    """Instance-wide used storage in bytes — the single source of truth for the
    member GET indicator, the admin storage header and cap enforcement.

    One figure, read straight off `instance_storage_totals`, so the number the
    page reports and the number an upload is refused against are the same call
    and cannot drift apart. What it counts is in `_USED_SUM`: the original plus
    every derived byte that has been measured.

    Counts the trash: a project, asset or version that has been deleted still
    holds its bytes in the bucket until it is purged, so the limit still blocks
    on them. This is the same scope the header reports, which is what lets the
    page promise free space the next upload really has (see `committed_media`).
    """
    return instance_storage_totals(db)["used_bytes"]


def project_storage_used_bytes(db: Session, project_id) -> int:
    """Used storage in bytes for a single project, trash excluded.

    What this project holds today, which is the figure `GET /projects` lists and
    the admin project rows show for the same project; the same `_USED_SUM` as
    the instance figure, with one filter on it. The instance-wide figure counts
    the trash because the limit does; one project's own trashed assets sit in
    the instance trash, which the project's members can neither see nor empty,
    so quoting them here would be a number nobody on the project can act on.
    The trashed bytes are reported where they can be acted on: beside the
    instance figure, as the part of it that emptying the trash would free.
    """
    return int(live_media(db, _USED_SUM).filter(
        Asset.project_id == project_id,
    ).scalar() or 0)


def project_storage_used_bytes_map(db: Session, project_ids) -> dict:
    """`project_storage_used_bytes` for a batch of projects, one grouped query.

    What `GET /projects` needs for a page of projects. It exists so the list
    endpoint does not hand-roll the join and the filter a second time: a copy
    that keeps the original sum while this file moved on is exactly how the
    header and the upload limit came to disagree.
    """
    ids = list(project_ids)
    if not ids:
        return {}
    rows = (
        live_media(db, Asset.project_id.label("project_id"), _USED_SUM.label("used_bytes"))
        .filter(Asset.project_id.in_(ids))
        .group_by(Asset.project_id)
        .all()
    )
    return {r.project_id: int(r.used_bytes) for r in rows}


# ── Admin storage overview ─────────────────────────────────────────────────────
#
# What the overview counts, and why it is only ever a grouped SUM over existing
# rows:
#
#   originals  MediaFile.file_size_bytes   the uploaded master, always recorded
#   derived    MediaFile.derived_size_bytes everything the transcode wrote under
#                                           the version's output prefix: HLS
#                                           renditions, the single-file
#                                           MP4/MP3/WebP, the poster thumbnail,
#                                           the audio waveform
#
# NOT counted, because nothing in the database records their size: project
# posters, instance branding logos, user avatars, comment attachments, and any
# object in the bucket that no live row points at (the retention purge's job).
# The figure is therefore the media whose size the database knows, never the
# bucket's total.
#
# `derived_size_bytes` IS NULL is "not measured yet", so the overview also
# reports how many committed files are still unmeasured. That is the number that
# tells an administrator whether the backfill has run, and it is why NULL is
# never coalesced into the derived total.


#: In the trash at any of the three levels that carry `deleted_at`. One
#: expression, used for both the trash figure and its complement, so "in the
#: trash" cannot come to mean two things. A project in the trash together with
#: one of its own trashed assets matches through one `or_` branch, not two, so
#: its bytes are counted once.
IN_TRASH = or_(
    Project.deleted_at.isnot(None),
    Asset.deleted_at.isnot(None),
    AssetVersion.deleted_at.isnot(None),
)
NOT_IN_TRASH = and_(
    Project.deleted_at.is_(None),
    Asset.deleted_at.is_(None),
    AssetVersion.deleted_at.is_(None),
)


def committed_media(db: Session, *columns):
    """`columns` over committed media: every byte the bucket still holds for a
    media file, the trash included.

    Committed means a version in `processing` or `ready`, so a file that was
    never finished uploading and a failed transcode are out. The trash is in,
    because deleting is not freeing: a soft-deleted project, asset or version
    keeps its objects until the retention collector or an admin purge removes
    them, and until then the bucket is as full as it was.

    This is the one definition. Every used-storage figure in the app is this
    query with `_USED_SUM` on it: the storage limit
    (`instance_storage_used_bytes`), the admin storage header, the member
    indicator and the per-project rows. That is the whole point: the header
    used to exclude the trash while the limit counted part of it, and then to
    add the derived bytes while the limit counted the originals alone, so a
    page could report free space and the very next upload be refused. The two
    scoped views below are the only two refinements of it, each a single filter
    on this query rather than a second query that can drift.
    """
    return db.query(*columns) \
        .select_from(MediaFile) \
        .join(AssetVersion, MediaFile.version_id == AssetVersion.id) \
        .join(Asset, AssetVersion.asset_id == Asset.id) \
        .join(Project, Asset.project_id == Project.id) \
        .filter(
            AssetVersion.processing_status.in_(
                [ProcessingStatus.processing, ProcessingStatus.ready]
            ),
        )


def live_media(db: Session, *columns):
    """Committed media that is not in the trash: what the per-project rows, the
    asset tree and a project's own figure are about.

    These lists are lists of things somebody can still open, so a trashed
    project has no row here and a trashed asset no line in its project's tree.
    Their bytes are not lost from the page: they are in the trash view, and in
    the trash figure under the header, which is the part of the used figure
    that emptying the trash would free.
    """
    return committed_media(db, *columns).filter(NOT_IN_TRASH)


def trashed_media(db: Session, *columns):
    """The part of committed media that is in the trash — a subset of the used
    figure, not a second figure beside it."""
    return committed_media(db, *columns).filter(IN_TRASH)


_ORIGINAL_SUM = func.coalesce(func.sum(MediaFile.file_size_bytes), 0)
_DERIVED_SUM = func.coalesce(func.sum(MediaFile.derived_size_bytes), 0)
#: **The** used-storage expression: the originals plus every derived byte that
#: has been measured. Every figure quoted against the instance capacity is this
#: one sum, optionally with one scope filter on it — the header, the member
#: indicator, the upload guard and the per-project rows. A second sum beside it
#: is how the header came to promise free space that the next upload was
#: refused for.
#:
#: Derived bytes count because the bucket holds them: a 6 GB original with 4 GB
#: of renditions occupies 10 GB, and a cap that ignored the renditions would be
#: a cap on 60 % of the storage it is set against. The cost is that an instance
#: whose backfill has only just measured its renditions reads as fuller than it
#: did the day before, on an unchanged bucket — true all along, merely unknown.
#: `unmeasured_files` is reported beside the figure so that is visible, and the
#: deploy note tells an administrator to re-check the cap after the backfill.
_USED_SUM = _ORIGINAL_SUM + _DERIVED_SUM
# Files whose derived bytes have never been measured. Counted, not summed:
# summing NULL as zero would report a total the bucket does not hold.
_UNMEASURED_COUNT = func.count(MediaFile.id).filter(MediaFile.derived_size_bytes.is_(None))


def project_storage_rows(db: Session) -> list[dict]:
    """Per-project storage, one grouped query, largest first.

    Only projects that hold committed bytes appear; an empty project has nothing
    to show in a storage overview and would only push the real rows down.
    """
    rows = (
        live_media(
            db,
            Asset.project_id.label("project_id"),
            _ORIGINAL_SUM.label("original_bytes"),
            _DERIVED_SUM.label("derived_bytes"),
            _UNMEASURED_COUNT.label("unmeasured_files"),
            func.count(func.distinct(Asset.id)).label("asset_count"),
        )
        .group_by(Asset.project_id)
        .all()
    )
    out = [
        {
            "project_id": r.project_id,
            "original_bytes": int(r.original_bytes),
            "derived_bytes": int(r.derived_bytes),
            # The breakdown added up again, which is `_USED_SUM` for this
            # project: equal to `project_storage_used_bytes(db, project_id)`.
            "total_bytes": int(r.original_bytes) + int(r.derived_bytes),
            "unmeasured_files": int(r.unmeasured_files),
            "asset_count": int(r.asset_count),
        }
        for r in rows
    ]
    # Sorted here, not in SQL: the sort key is the sum of two coalesced sums and
    # spelling it out again in an ORDER BY is one more place to get it wrong.
    out.sort(key=lambda r: r["total_bytes"], reverse=True)
    return out


def project_storage_tree(db: Session, project_id) -> list[dict]:
    """One project's committed media as asset -> version -> file, each level with
    its own byte totals, largest first at every level.

    Two queries regardless of project size: one for the files, one for the asset
    and version names. The tree is only ever fetched for the project an
    administrator expanded, never for the whole instance.
    """
    files = (
        live_media(
            db,
            Asset.id.label("asset_id"),
            Asset.name.label("asset_name"),
            Asset.asset_type.label("asset_type"),
            AssetVersion.id.label("version_id"),
            AssetVersion.version_number.label("version_number"),
            MediaFile.id.label("file_id"),
            MediaFile.original_filename.label("filename"),
            MediaFile.file_size_bytes.label("original_bytes"),
            MediaFile.derived_size_bytes.label("derived_bytes"),
        )
        .filter(Asset.project_id == project_id)
        .all()
    )

    assets: dict = {}
    for f in files:
        asset = assets.setdefault(
            f.asset_id,
            {
                "asset_id": f.asset_id,
                "name": f.asset_name,
                "asset_type": getattr(f.asset_type, "value", f.asset_type),
                "original_bytes": 0,
                "derived_bytes": 0,
                "total_bytes": 0,
                "unmeasured_files": 0,
                "versions": {},
            },
        )
        version = asset["versions"].setdefault(
            f.version_id,
            {
                "version_id": f.version_id,
                "version_number": f.version_number,
                "original_bytes": 0,
                "derived_bytes": 0,
                "total_bytes": 0,
                "unmeasured_files": 0,
                "files": [],
            },
        )
        original = int(f.original_bytes or 0)
        derived = int(f.derived_bytes) if f.derived_bytes is not None else 0
        version["files"].append({
            "file_id": f.file_id,
            "filename": f.filename,
            "original_bytes": original,
            # None, not 0: the UI marks an unmeasured file rather than drawing a
            # bar that claims the transcode output is empty.
            "derived_bytes": int(f.derived_bytes) if f.derived_bytes is not None else None,
            "total_bytes": original + derived,
        })
        for level in (asset, version):
            level["original_bytes"] += original
            level["derived_bytes"] += derived
            level["total_bytes"] += original + derived
            if f.derived_bytes is None:
                level["unmeasured_files"] += 1

    tree = []
    for asset in assets.values():
        versions = list(asset["versions"].values())
        for v in versions:
            v["files"].sort(key=lambda x: x["total_bytes"], reverse=True)
        versions.sort(key=lambda v: v["total_bytes"], reverse=True)
        asset["versions"] = versions
        tree.append(asset)
    tree.sort(key=lambda a: a["total_bytes"], reverse=True)
    return tree


def instance_storage_totals(db: Session) -> dict:
    """Instance-wide originals, derived bytes, the used figure they add up to and
    the unmeasured file count, trash included — the figures the admin storage
    header reports.

    `used_bytes` is `_USED_SUM`, and it is the figure the cap is enforced
    against: `instance_storage_used_bytes` returns this key, so the header's
    "x of y used, z free" and the upload guard's refusal are one number by
    construction rather than by two functions agreeing. `original_bytes` and
    `derived_bytes` are the breakdown of it, for the panel to show where the
    bytes went, not two candidate totals to choose between.
    """
    row = committed_media(
        db,
        _ORIGINAL_SUM.label("original_bytes"),
        _DERIVED_SUM.label("derived_bytes"),
        _UNMEASURED_COUNT.label("unmeasured_files"),
        func.count(MediaFile.id).label("file_count"),
    ).one()
    return {
        "original_bytes": int(row.original_bytes),
        "derived_bytes": int(row.derived_bytes),
        "used_bytes": int(row.original_bytes) + int(row.derived_bytes),
        "unmeasured_files": int(row.unmeasured_files),
        "file_count": int(row.file_count),
    }


def project_total_bytes(db: Session, project_id) -> int:
    """What a live project holds — the figure the delete confirmation quotes as
    what goes to the trash, and what emptying the trash afterwards would free.

    The same call as the figure on the project and in the panel's row for it
    (`project_storage_used_bytes`), kept as its own name because the
    confirmation dialog asks a different question of it.
    """
    return project_storage_used_bytes(db, project_id)


def storage_cap_error(db: Session, incoming_bytes: int) -> str | None:
    """Return an error detail if accepting `incoming_bytes` would exceed the instance
    storage cap, else None. Limit 0 (unlimited) short-circuits before any usage query.
    """
    limit = get_storage_limit(db)
    if not limit:
        return None
    used = instance_storage_used_bytes(db)
    if used + incoming_bytes > limit:
        return f"Storage limit reached — {_format_bytes(used)} of {_format_bytes(limit)} used"
    return None


def upload_guard_error(db: Session, file_size_bytes: int) -> str | None:
    """Combined pre-upload guard: the per-file cap (env `MAX_UPLOAD_BYTES`) first, then the
    instance-wide storage cap (DB). Returns the first error message, or None if both pass."""
    return upload_size_error(file_size_bytes) or storage_cap_error(db, file_size_bytes)
