"""Folder depth, and find-or-create for the folder paths of a folder upload.

A dropped or picked folder is recreated under the folder it was dropped onto,
keeping its names. Each segment reuses the live folder of that name under that
parent, or creates it, so uploading the same folder twice merges into the first
copy instead of making a second one.

MAX_FOLDER_DEPTH and the depth walk live here rather than in routers/folders.py
so this service and that router can share them; the router imports both.
"""
import unicodedata
import uuid
from typing import Optional

from sqlalchemy import or_, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from ..models.folder import Folder

MAX_FOLDER_DEPTH = 10

#: The most parent links one depth walk follows. `folders.parent_id` is a plain
#: self-reference, so a stored chain can be a cycle or absurdly long; the walk
#: stops instead of looping. Well above MAX_FOLDER_DEPTH on purpose, so a tree
#: that is merely too deep still reports its real depth.
MAX_DEPTH_WALK = 1000

#: Paths one ensure request may name.
MAX_ENSURE_PATHS = 500
#: Distinct folders (path prefixes) one ensure request may name. 500 paths of
#: 10 segments could name 5,000; the web client splits a drop below this.
MAX_ENSURE_NODES = 2000

#: The longest folder name the column holds.
MAX_FOLDER_NAME_LENGTH: int = Folder.__table__.c.name.type.length

_FORBIDDEN_IN_NAME = ("/", "\\", "\x00")


def _get_depth(db: Session, folder_id: Optional[uuid.UUID]) -> int:
    """How many folders there are from the project root down to `folder_id`,
    itself included (0 for the root).

    Stops at the first folder it has already seen, so a parent cycle ends the
    walk with the number of distinct folders on it, and gives up after
    MAX_DEPTH_WALK links.
    """
    depth = 0
    seen: set[uuid.UUID] = set()
    current_id = folder_id
    while current_id and current_id not in seen and depth < MAX_DEPTH_WALK:
        seen.add(current_id)
        depth += 1
        row = db.query(Folder.parent_id).filter(Folder.id == current_id).first()
        if row is None:
            break
        current_id = row.parent_id
    return depth


def normalize_folder_name(name: str) -> str:
    """The name a folder segment is stored and matched under: NFC, then
    stripped. macOS reports decomposed (NFD) names, so without this the same
    folder uploaded from two machines would not merge."""
    return unicodedata.normalize("NFC", name).strip()


def folder_name_problem(name: str) -> Optional[str]:
    """Why `name` (already normalised) cannot be a folder name, or None."""
    if not name:
        return "a folder name cannot be empty"
    if len(name) > MAX_FOLDER_NAME_LENGTH:
        return f"a folder name cannot be longer than {MAX_FOLDER_NAME_LENGTH} characters"
    if name in (".", ".."):
        return "a folder name cannot be '.' or '..'"
    if any(c in name for c in _FORBIDDEN_IN_NAME):
        return "a folder name cannot contain '/', '\\' or a NUL character"
    return None


def distinct_prefixes(paths: list[tuple[str, ...]]) -> int:
    """How many distinct folders the paths name, counting each prefix once:
    ("A", "B") and ("A", "C") name A, A/B and A/C."""
    return len({p[:k] for p in paths for k in range(1, len(p) + 1)})


def lock_project_folders(db: Session, project_id: uuid.UUID) -> None:
    """Serialize folder find-or-create in `project_id` until the caller's
    transaction ends. At the project root the unique index never fires (a NULL
    parent_id is never equal to another), so this lock is the only thing that
    stops two concurrent uploads of one folder making two root folders."""
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(CAST(:project_id AS text), 0))"),
        {"project_id": str(project_id)},
    )


def _find_live(
    db: Session,
    project_id: uuid.UUID,
    wanted: set[tuple[Optional[uuid.UUID], str]],
) -> dict[tuple[Optional[uuid.UUID], str], uuid.UUID]:
    """The live folder for each (parent_id, name) in `wanted` that has one.

    When several live folders share a key, which only the project root allows,
    the oldest by (created_at, id) wins, so every upload picks the same one.
    """
    if not wanted:
        return {}
    parent_ids = [p for p, _ in wanted if p is not None]
    parent_filter = []
    if parent_ids:
        parent_filter.append(Folder.parent_id.in_(set(parent_ids)))
    if any(p is None for p, _ in wanted):
        parent_filter.append(Folder.parent_id.is_(None))
    rows = db.execute(
        select(Folder.id, Folder.parent_id, Folder.name)
        .where(
            Folder.project_id == project_id,
            Folder.deleted_at.is_(None),
            Folder.name.in_({name for _, name in wanted}),
            or_(*parent_filter),
        )
        .order_by(Folder.created_at, Folder.id)
    ).all()
    found: dict[tuple[Optional[uuid.UUID], str], uuid.UUID] = {}
    for folder_id, parent_id, name in rows:
        key = (parent_id, name)
        if key in wanted and key not in found:
            found[key] = folder_id
    return found


def ensure_folder_paths(
    db: Session,
    project_id: uuid.UUID,
    parent_id: Optional[uuid.UUID],
    paths: list[tuple[str, ...]],
    created_by: uuid.UUID,
) -> dict[tuple[str, ...], Optional[uuid.UUID]]:
    """Find or create every folder `paths` names under `parent_id` (None: the
    project root), and map each path to the folder it ends in.

    The paths must already be normalised and valid, and the parent a live
    folder of the project. Runs in the caller's transaction, which must commit
    it: the advisory lock it takes is held until then.

    MAX_FOLDER_DEPTH counts from the project root, so each path is cut to
    `MAX_FOLDER_DEPTH - depth(parent)` segments and maps to the deepest folder
    allowed. When the parent is already at or past the limit nothing is made
    and every path maps to None, meaning the parent itself.

    Works one level at a time, with one lookup and at most one insert per level
    whatever the number of paths.
    """
    lock_project_folders(db, project_id)
    room = max(0, MAX_FOLDER_DEPTH - _get_depth(db, parent_id))
    cut = {path: path[:room] for path in paths}

    ids: dict[tuple[str, ...], Optional[uuid.UUID]] = {(): parent_id}
    for level in range(1, room + 1):
        prefixes = {c[:level] for c in cut.values() if len(c) >= level}
        if not prefixes:
            break
        wanted = {(ids[prefix[:-1]], prefix[-1]) for prefix in prefixes}
        found = _find_live(db, project_id, wanted)
        # Sorted so concurrent inserts take index entries in the same order.
        missing = sorted(
            (key for key in wanted if key not in found),
            key=lambda key: (str(key[0]), key[1]),
        )
        if missing:
            created = db.execute(
                pg_insert(Folder)
                .values([
                    {
                        "id": uuid.uuid4(),
                        "project_id": project_id,
                        "parent_id": parent,
                        "name": name,
                        "created_by": created_by,
                    }
                    for parent, name in missing
                ])
                .on_conflict_do_nothing(
                    index_elements=["project_id", "parent_id", "name"],
                    index_where=Folder.deleted_at.is_(None),
                )
                .returning(Folder.id, Folder.parent_id, Folder.name)
            ).all()
            for folder_id, parent, name in created:
                found[(parent, name)] = folder_id
            # A row the insert skipped is one an ordinary folder create (which
            # does not take the lock) committed first under the same parent.
            skipped = {key for key in missing if key not in found}
            found.update(_find_live(db, project_id, skipped))
        for prefix in prefixes:
            ids[prefix] = found[(ids[prefix[:-1]], prefix[-1])]

    return {path: (ids[c] if c else None) for path, c in cut.items()}
