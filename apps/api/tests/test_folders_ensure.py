"""POST /projects/{project_id}/folders/ensure: recreate a dropped folder tree.

A folder drop names its folders as paths relative to the folder it was dropped
onto (or the project root). Each segment reuses the live folder of that name
under that parent, or is created, so dropping the same folder twice merges
into the first copy instead of making a second one.

These run against a real Postgres: the partial unique index, ON CONFLICT and
the per-project advisory lock only mean anything there. Most tests go through
the real app on a session whose commits are SAVEPOINTs, rolled back at the end.
The concurrency test needs two connections that really commit, so it makes and
removes its own rows.
"""
import queue
import threading
import time
import unicodedata
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from apps.api.models.folder import Folder
from apps.api.models.project import Project, ProjectMember, ProjectRole, ProjectType
from apps.api.models.user import User


MAX_DEPTH = 10


@pytest.fixture
def db():
    """A real session where each route commit is a SAVEPOINT the test can observe."""
    from apps.api.database import engine

    conn = engine.connect()
    trans = conn.begin()
    session = Session(bind=conn, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        trans.rollback()
        conn.close()


@pytest.fixture
def client(db):
    from unittest.mock import patch

    from fastapi.testclient import TestClient

    from apps.api.database import get_db
    from apps.api.main import app

    with patch("apps.api.services.s3_service.ensure_bucket_exists"):
        app.dependency_overrides[get_db] = lambda: db
        c = TestClient(app, raise_server_exceptions=False)
        # A fresh address per test keeps the global write limit out of the way.
        c.headers["x-real-ip"] = (
            f"10.{uuid.uuid4().int % 250}.{uuid.uuid4().int % 250}.{uuid.uuid4().int % 250}"
        )
        yield c
    app.dependency_overrides.clear()


def _auth(user):
    from apps.api.services.auth_service import create_access_token

    return {"Authorization": f"Bearer {create_access_token(str(user.id), user.token_version or 1)}"}


class World:
    pass


@pytest.fixture
def w(db, client):
    """An editor, a viewer and a reviewer of `project`; `other` is a project the
    editor also edits, with a folder of its own."""
    w = World()
    w.db, w.client = db, client
    suffix = uuid.uuid4().hex[:10]
    w.editor = User(email=f"ensure-ed-{suffix}@t.local", name="Editor")
    w.viewer = User(email=f"ensure-vw-{suffix}@t.local", name="Viewer")
    w.reviewer = User(email=f"ensure-rv-{suffix}@t.local", name="Reviewer")
    db.add_all([w.editor, w.viewer, w.reviewer])
    db.flush()
    w.project = Project(name=f"ensure-{suffix}", project_type=ProjectType.personal,
                        created_by=w.editor.id)
    w.other = Project(name=f"ensure-other-{suffix}", project_type=ProjectType.personal,
                      created_by=w.editor.id)
    db.add_all([w.project, w.other])
    db.flush()
    db.add_all([
        ProjectMember(project_id=w.project.id, user_id=w.editor.id, role=ProjectRole.editor),
        ProjectMember(project_id=w.project.id, user_id=w.viewer.id, role=ProjectRole.viewer),
        ProjectMember(project_id=w.project.id, user_id=w.reviewer.id, role=ProjectRole.reviewer),
        ProjectMember(project_id=w.other.id, user_id=w.editor.id, role=ProjectRole.owner),
    ])
    db.flush()
    w.foreign = Folder(project_id=w.other.id, name="Elsewhere", created_by=w.editor.id)
    db.add(w.foreign)
    db.commit()
    return w


def _ensure(w, paths, parent_id=None, user=None):
    return w.client.post(
        f"/projects/{w.project.id}/folders/ensure",
        json={"parent_id": str(parent_id) if parent_id else None, "paths": paths},
        headers=_auth(user or w.editor),
    )


def _ok(w, paths, parent_id=None) -> list[dict]:
    response = _ensure(w, paths, parent_id)
    assert response.status_code == 200, response.text
    return response.json()["folders"]


def _ids(folders: list[dict]) -> dict[tuple, str | None]:
    return {tuple(f["path"]): f["folder_id"] for f in folders}


def _live_count(w) -> int:
    w.db.expire_all()
    return w.db.query(func.count(Folder.id)).filter(
        Folder.project_id == w.project.id, Folder.deleted_at.is_(None),
    ).scalar()


def _folder(w, folder_id) -> Folder:
    w.db.expire_all()
    return w.db.query(Folder).filter(Folder.id == uuid.UUID(str(folder_id))).one()


def _chain(w, length: int) -> list[uuid.UUID]:
    """L1 > L2 > ... > Ln with L1 at the project root, written to the table
    directly so a chain past MAX_FOLDER_DEPTH can exist, as old data may."""
    parent, ids = None, []
    for i in range(length):
        folder = Folder(project_id=w.project.id, parent_id=parent, name=f"L{i + 1}",
                        created_by=w.editor.id)
        w.db.add(folder)
        w.db.flush()
        ids.append(folder.id)
        parent = folder.id
    w.db.commit()
    return ids


# ─── Create and merge ─────────────────────────────────────────────────────────


def test_creates_a_nested_tree_and_answers_in_request_order(w):
    before = _live_count(w)
    paths = [["Card", "DCIM", "100CANON"], ["Card", "MISC"], ["Card", "DCIM", "100CANON"]]

    folders = _ok(w, paths)

    # One entry per requested path, duplicates included, in request order.
    assert [f["path"] for f in folders] == paths
    assert folders[0]["folder_id"] == folders[2]["folder_id"]
    assert _live_count(w) == before + 4  # Card, DCIM, 100CANON, MISC
    leaf = _folder(w, folders[0]["folder_id"])
    dcim = _folder(w, leaf.parent_id)
    card = _folder(w, dcim.parent_id)
    misc = _folder(w, folders[1]["folder_id"])
    assert (card.name, dcim.name, leaf.name, misc.name) == ("Card", "DCIM", "100CANON", "MISC")
    assert card.parent_id is None and misc.parent_id == card.id
    for f in (card, dcim, leaf, misc):
        assert f.project_id == w.project.id
        assert f.created_by == w.editor.id
        assert f.deleted_at is None


def test_running_it_again_reuses_every_folder(w):
    paths = [["Shoot", "A"], ["Shoot", "B", "Raw"]]
    first = _ids(_ok(w, paths))
    count = _live_count(w)

    second = _ids(_ok(w, paths + [["Shoot", "C"]]))

    assert {k: second[k] for k in first} == first
    assert _live_count(w) == count + 1  # only C is new


def test_merges_into_a_folder_made_by_hand(w):
    """A folder created through POST /folders is the one a drop of that name
    lands in, below the root as well as at it."""
    made = w.client.post(f"/projects/{w.project.id}/folders", json={"name": "Shoot"},
                         headers=_auth(w.editor))
    assert made.status_code == 201, made.text
    inner = w.client.post(f"/projects/{w.project.id}/folders",
                          json={"name": "Day 1", "parent_id": made.json()["id"]},
                          headers=_auth(w.editor))
    assert inner.status_code == 201, inner.text
    count = _live_count(w)

    got = _ids(_ok(w, [["Shoot", "Day 1"]]))

    assert got[("Shoot", "Day 1")] == inner.json()["id"]
    assert _live_count(w) == count


def test_at_the_root_the_oldest_of_existing_duplicates_wins(w):
    """Nothing indexes a NULL parent, so two root folders of one name can
    already exist. The oldest is reused every time, and no third is made."""
    now = datetime.now(timezone.utc)
    older = Folder(project_id=w.project.id, name="Card", created_by=w.editor.id,
                   created_at=now - timedelta(days=2))
    newer = Folder(project_id=w.project.id, name="Card", created_by=w.editor.id,
                   created_at=now - timedelta(days=1))
    other_case = Folder(project_id=w.project.id, name="card", created_by=w.editor.id,
                        created_at=now - timedelta(days=3))
    w.db.add_all([newer, older, other_case])
    w.db.commit()
    count = _live_count(w)

    got = _ids(_ok(w, [["Card"], ["Card", "Sub"]]))

    assert got[("Card",)] == str(older.id)
    assert _folder(w, got[("Card", "Sub")]).parent_id == older.id
    assert _live_count(w) == count + 1  # Sub only; "card" is another name
    assert _ids(_ok(w, [["Card"]]))[("Card",)] == str(older.id)


def test_a_trashed_folder_of_that_name_is_not_reused(w):
    trashed = Folder(project_id=w.project.id, name="Gone", created_by=w.editor.id,
                     deleted_at=datetime.now(timezone.utc))
    w.db.add(trashed)
    w.db.commit()

    got = _ids(_ok(w, [["Gone", "Inner"]]))

    parent = _folder(w, _folder(w, got[("Gone", "Inner")]).parent_id)
    assert parent.id != trashed.id
    assert parent.name == "Gone" and parent.deleted_at is None and parent.parent_id is None
    assert _folder(w, trashed.id).deleted_at is not None


def test_under_a_parent_the_tree_is_made_inside_it(w):
    target = _ids(_ok(w, [["Target"]]))[("Target",)]

    got = _ids(_ok(w, [["Card", "DCIM"]], parent_id=target))

    card = _folder(w, _folder(w, got[("Card", "DCIM")]).parent_id)
    assert str(card.parent_id) == target
    # A root "Card" is a different folder from the one under Target.
    assert _ids(_ok(w, [["Card"]]))[("Card",)] != str(card.id)


def test_names_are_nfc_normalised_and_stripped(w):
    """macOS hands over decomposed names. Without normalising, the same folder
    dropped from two machines would not merge. The response echoes each path as
    it was sent, so the client can look up its own keys."""
    nfd = unicodedata.normalize("NFD", "Café")
    nfc = unicodedata.normalize("NFC", "Café")
    assert nfd != nfc

    folders = _ok(w, [[nfd], [nfc], ["  Padded  "], ["Padded"]])

    assert [f["path"] for f in folders] == [[nfd], [nfc], ["  Padded  "], ["Padded"]]
    assert folders[0]["folder_id"] == folders[1]["folder_id"]
    assert folders[2]["folder_id"] == folders[3]["folder_id"]
    assert _folder(w, folders[0]["folder_id"]).name == nfc
    assert _folder(w, folders[2]["folder_id"]).name == "Padded"


# ─── Depth ────────────────────────────────────────────────────────────────────


def test_from_the_root_all_ten_levels_are_made(w):
    path = [f"d{i}" for i in range(MAX_DEPTH)]

    got = _ids(_ok(w, [path]))

    leaf = _folder(w, got[tuple(path)])
    assert leaf.name == f"d{MAX_DEPTH - 1}"


def test_paths_are_cut_at_the_depth_limit_below_a_deep_parent(w):
    """Depth counts from the project root: below a folder at depth 8 only two
    more levels fit, and anything deeper maps to the deepest folder allowed."""
    chain = _chain(w, 8)
    count = _live_count(w)

    got = _ids(_ok(w, [["a", "b", "c", "d"], ["a", "b", "x"], ["a"]], parent_id=chain[-1]))

    assert _live_count(w) == count + 2  # a and b
    b = _folder(w, got[("a", "b", "c", "d")])
    a = _folder(w, got[("a",)])
    assert b.name == "b" and b.parent_id == a.id and a.parent_id == chain[-1]
    assert got[("a", "b", "x")] == str(b.id)
    # b is at exactly the limit, so the ordinary create refuses below it.
    refused = w.client.post(f"/projects/{w.project.id}/folders",
                            json={"name": "c", "parent_id": str(b.id)},
                            headers=_auth(w.editor))
    assert refused.status_code == 400, refused.text


@pytest.mark.parametrize("parent_depth", [MAX_DEPTH, MAX_DEPTH + 1])
def test_a_parent_at_or_past_the_limit_maps_every_path_to_null(w, parent_depth):
    """No room below the parent: nothing is made and each path's folder_id is
    null, meaning its files go into the parent itself."""
    chain = _chain(w, parent_depth)
    count = _live_count(w)

    got = _ids(_ok(w, [["a"], ["a", "b"]], parent_id=chain[-1]))

    assert got == {("a",): None, ("a", "b"): None}
    assert _live_count(w) == count


# ─── The parent ───────────────────────────────────────────────────────────────


def test_a_parent_that_is_not_a_live_folder_of_this_project_is_400(w):
    now = datetime.now(timezone.utc)
    trashed = Folder(project_id=w.project.id, name="Trashed", created_by=w.editor.id,
                     deleted_at=now)
    w.db.add(trashed)
    w.db.flush()
    # Live itself, but inside a trashed folder: still in the trash.
    in_trashed = Folder(project_id=w.project.id, parent_id=trashed.id, name="Inside",
                        created_by=w.editor.id)
    w.db.add(in_trashed)
    w.db.commit()
    count = _live_count(w)

    for parent in (trashed.id, in_trashed.id, w.foreign.id, uuid.uuid4()):
        response = _ensure(w, [["New"]], parent_id=parent)
        assert response.status_code == 400, response.text
        assert response.json()["detail"]["code"] == "folder_not_in_project"
    assert _live_count(w) == count

    # The contrast: a live folder of this project is accepted.
    target = _ids(_ok(w, [["Target"]]))[("Target",)]
    got = _ids(_ok(w, [["New"]], parent_id=target))
    assert str(_folder(w, got[("New",)]).parent_id) == target


# ─── Who may call it ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("role", ["viewer", "reviewer"])
def test_viewers_and_reviewers_are_refused(w, role):
    count = _live_count(w)

    response = _ensure(w, [["New"]], user=getattr(w, role))

    assert response.status_code == 403, response.text
    assert _live_count(w) == count


def test_a_deleted_project_is_not_found(w):
    assert _ensure(w, [["Before"]]).status_code == 200
    w.project.deleted_at = datetime.now(timezone.utc)
    w.db.commit()
    count = _live_count(w)

    response = _ensure(w, [["After"]])

    assert response.status_code == 404, response.text
    assert response.json() == {"detail": "Project not found"}
    assert _live_count(w) == count


# ─── Validation ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("paths", [
    pytest.param([], id="no-paths"),
    pytest.param([[]], id="empty-path"),
    pytest.param([[f"d{i}" for i in range(MAX_DEPTH + 1)]], id="eleven-segments"),
    pytest.param([["a"]] * 501, id="501-paths"),
    pytest.param([[""]], id="empty-segment"),
    pytest.param([["   "]], id="blank-segment"),
    pytest.param([["."]], id="dot"),
    pytest.param([["a", ".."]], id="dot-dot"),
    pytest.param([[" .. "]], id="dot-dot-after-strip"),
    pytest.param([["a/b"]], id="slash"),
    pytest.param([["a\\b"]], id="backslash"),
    pytest.param([["a\x00b"]], id="nul"),
    pytest.param([["x" * 256]], id="256-chars"),
])
def test_invalid_paths_are_422_and_write_nothing(w, paths):
    count = _live_count(w)

    response = _ensure(w, paths)

    assert response.status_code == 422, response.text
    assert _live_count(w) == count


def test_names_at_the_edges_are_accepted(w):
    folders = _ok(w, [["x" * 255], ["...", ".hidden"], [f"  {'y' * 255}  "]])

    assert len(folders) == 3
    assert _folder(w, folders[2]["folder_id"]).name == "y" * 255


def test_more_than_2000_distinct_folders_is_422_too_many_folders(w):
    count = _live_count(w)
    # 201 paths of 10 distinct segments name 2,010 folders.
    over = [[f"p{i}"] + [f"s{j}" for j in range(9)] for i in range(201)]

    response = _ensure(w, over)

    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "too_many_folders"
    assert _live_count(w) == count

    # Exactly 2,000 is allowed and makes that many.
    at_limit = over[:200]
    assert len(_ok(w, at_limit)) == 200
    assert _live_count(w) == count + 2000


# ─── Concurrency ──────────────────────────────────────────────────────────────


def test_two_sessions_ensuring_the_same_root_path_make_one_folder():
    """Two tabs dropping the same folder at once, at the project root where the
    unique index does not apply. Session A has made the folders but not
    committed; session B must wait for A and then reuse A's folders.

    Two real connections that commit, so this test cleans up after itself.
    """
    from apps.api.database import engine
    from apps.api.services.folder_paths import ensure_folder_paths

    suffix = uuid.uuid4().hex[:10]
    user_id, project_id = uuid.uuid4(), uuid.uuid4()
    with Session(engine) as setup:
        setup.add(User(id=user_id, email=f"ensure-race-{suffix}@t.local", name="Race"))
        setup.flush()
        setup.add(Project(id=project_id, name=f"ensure-race-{suffix}",
                          project_type=ProjectType.personal, created_by=user_id))
        setup.commit()

    paths = [("Card", "DCIM"), ("Card", "MISC")]
    b_pid: queue.Queue = queue.Queue()
    b_result: queue.Queue = queue.Queue()

    def session_b():
        try:
            with Session(engine) as b:
                b_pid.put(b.execute(text("SELECT pg_backend_pid()")).scalar())
                got = ensure_folder_paths(b, project_id, None, paths, user_id)
                b.commit()
                b_result.put(got)
        except Exception as e:  # surfaced by the assertion below
            b_result.put(e)

    a = Session(engine)
    thread = threading.Thread(target=session_b, daemon=True)
    try:
        got_a = ensure_folder_paths(a, project_id, None, paths, user_id)

        thread.start()
        pid = b_pid.get(timeout=10)
        # Wait until B is either blocked on the advisory lock or done.
        deadline = time.monotonic() + 10
        b_waited = False
        with engine.connect() as probe:
            while time.monotonic() < deadline and thread.is_alive():
                waiting = probe.execute(
                    text("SELECT count(*) FROM pg_locks WHERE pid = :pid "
                         "AND locktype = 'advisory' AND NOT granted"),
                    {"pid": pid},
                ).scalar()
                if waiting:
                    b_waited = True
                    break
                time.sleep(0.02)

        a.commit()
        thread.join(timeout=10)
        assert not thread.is_alive()
        got_b = b_result.get(timeout=1)
        assert not isinstance(got_b, Exception), got_b

        with engine.connect() as conn:
            rows = conn.execute(
                text("SELECT name, count(*) FROM folders WHERE project_id = :p "
                     "AND deleted_at IS NULL GROUP BY name"),
                {"p": project_id},
            ).all()
        assert dict(rows) == {"Card": 1, "DCIM": 1, "MISC": 1}
        assert got_b == got_a
        assert b_waited, "session B never waited for session A's lock"
    finally:
        a.close()
        if thread.is_alive():
            thread.join(timeout=10)
        with engine.begin() as conn:
            # Leaves before parents: folders.parent_id has no ON DELETE.
            for _ in range(MAX_DEPTH + 1):
                conn.execute(
                    text("DELETE FROM folders f WHERE f.project_id = :p AND NOT EXISTS "
                         "(SELECT 1 FROM folders c WHERE c.parent_id = f.id)"),
                    {"p": project_id},
                )
            conn.execute(text("DELETE FROM projects WHERE id = :p"), {"p": project_id})
            conn.execute(text("DELETE FROM users WHERE id = :u"), {"u": user_id})


# ─── _get_depth ───────────────────────────────────────────────────────────────


def test_get_depth_terminates_on_a_parent_cycle(w):
    """folders.parent_id is a plain self-reference, so a cycle can be stored.
    The depth walk used to follow it forever, hanging every create, move and
    ensure that touched it."""
    from apps.api.routers.folders import _get_depth

    first = Folder(project_id=w.project.id, name="Loop A", created_by=w.editor.id)
    w.db.add(first)
    w.db.flush()
    second = Folder(project_id=w.project.id, parent_id=first.id, name="Loop B",
                    created_by=w.editor.id)
    w.db.add(second)
    w.db.flush()
    first.parent_id = second.id
    w.db.commit()

    result: queue.Queue = queue.Queue()
    thread = threading.Thread(target=lambda: result.put(_get_depth(w.db, first.id)),
                              daemon=True)
    thread.start()
    thread.join(timeout=10)

    assert not thread.is_alive(), "_get_depth did not stop on a cycle"
    assert result.get_nowait() == 2

    # The contrast: an ordinary chain counts every level.
    chain = _chain(w, 3)
    assert _get_depth(w.db, chain[-1]) == 3
    assert _get_depth(w.db, None) == 0


# ─── Racing ordinary writers ──────────────────────────────────────────────────
#
# These also need connections that really commit, so they make and remove
# their own rows through the `committed` fixture.


class Committed:
    pass


@pytest.fixture
def committed():
    """A committed editor, project and root folder `P`, removed afterwards."""
    from apps.api.database import engine

    c = Committed()
    c.engine = engine
    suffix = uuid.uuid4().hex[:10]
    c.user_id, c.project_id, c.parent_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    with Session(engine) as setup:
        setup.add(User(id=c.user_id, email=f"ensure-race-{suffix}@t.local", name="Race"))
        setup.flush()
        setup.add(Project(id=c.project_id, name=f"ensure-race-{suffix}",
                          project_type=ProjectType.personal, created_by=c.user_id))
        setup.flush()
        setup.add(ProjectMember(project_id=c.project_id, user_id=c.user_id,
                                role=ProjectRole.editor))
        setup.add(Folder(id=c.parent_id, project_id=c.project_id, name="P",
                         created_by=c.user_id))
        setup.commit()
    try:
        yield c
    finally:
        with engine.begin() as conn:
            for _ in range(MAX_DEPTH + 2):
                conn.execute(
                    text("DELETE FROM folders f WHERE f.project_id = :p AND NOT EXISTS "
                         "(SELECT 1 FROM folders c WHERE c.parent_id = f.id)"),
                    {"p": c.project_id},
                )
            conn.execute(text("DELETE FROM project_members WHERE project_id = :p"),
                         {"p": c.project_id})
            conn.execute(text("DELETE FROM projects WHERE id = :p"), {"p": c.project_id})
            conn.execute(text("DELETE FROM users WHERE id = :u"), {"u": c.user_id})


def _in_thread(engine, work):
    """Run `work(session)` on its own connection in a thread. Returns the
    thread, a queue holding the connection's backend pid, and one that gets the
    result or the exception."""
    pid: queue.Queue = queue.Queue()
    result: queue.Queue = queue.Queue()

    def run():
        try:
            with Session(engine) as s:
                pid.put(s.execute(text("SELECT pg_backend_pid()")).scalar())
                result.put(work(s))
        except Exception as e:  # surfaced by the caller
            result.put(e)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread, pid, result


def _wait_until_blocked(engine, pid: int, thread: threading.Thread) -> bool:
    """True once backend `pid` waits on any lock, False if `thread` ends first
    or ten seconds pass."""
    deadline = time.monotonic() + 10
    with engine.connect() as probe:
        while time.monotonic() < deadline and thread.is_alive():
            waiting = probe.execute(
                text("SELECT count(*) FROM pg_locks WHERE pid = :pid AND NOT granted"),
                {"pid": pid},
            ).scalar()
            if waiting:
                return True
            time.sleep(0.02)
    return False


def _live_folders(engine, project_id) -> list[tuple]:
    with engine.connect() as conn:
        return conn.execute(
            text("SELECT id, parent_id, name FROM folders WHERE project_id = :p "
                 "AND deleted_at IS NULL"),
            {"p": project_id},
        ).all()


@pytest.mark.parametrize("outcome", ["commit", "rollback"])
def test_a_plain_create_in_flight_under_the_parent_is_reused_or_replaced(committed, outcome):
    """An ordinary folder create does not take the project lock. When it has
    inserted `N` under P but not committed, ensure's insert of N waits on the
    unique index, skips the row if the create commits and reuses that folder,
    and makes N itself if the create rolls back. Either way there is one N."""
    from apps.api.services.folder_paths import ensure_folder_paths

    c = committed
    plain = Session(c.engine)
    plain_n_id = uuid.uuid4()
    plain.add(Folder(id=plain_n_id, project_id=c.project_id, parent_id=c.parent_id,
                     name="N", created_by=c.user_id))
    plain.flush()

    def ensure(s):
        got = ensure_folder_paths(s, c.project_id, c.parent_id, [("N", "M")], c.user_id)
        s.commit()
        return got

    thread, pid, result = _in_thread(c.engine, ensure)
    try:
        assert _wait_until_blocked(c.engine, pid.get(timeout=10), thread), \
            "ensure never waited for the uncommitted N"
        if outcome == "commit":
            plain.commit()
        else:
            plain.rollback()
        thread.join(timeout=10)
        assert not thread.is_alive()
        got = result.get(timeout=1)
        assert not isinstance(got, Exception), got
    finally:
        plain.close()

    rows = _live_folders(c.engine, c.project_id)
    by_name: dict[str, list] = {}
    for row in rows:
        by_name.setdefault(row.name, []).append(row)
    assert sorted(by_name) == ["M", "N", "P"]
    assert all(len(v) == 1 for v in by_name.values()), rows
    n, m = by_name["N"][0], by_name["M"][0]
    assert n.parent_id == c.parent_id and m.parent_id == n.id
    assert got[("N", "M")] == m.id
    if outcome == "commit":
        assert n.id == plain_n_id
    else:
        assert n.id != plain_n_id


def test_a_delete_in_flight_wins_over_ensure_into_that_folder(committed):
    """A delete of P that has started but not committed holds the project lock.
    An ensure into P must wait for it and then refuse, instead of checking P
    before the lock and making live folders inside a trashed one."""
    from fastapi import HTTPException

    from apps.api.routers.folders import ensure_folders
    from apps.api.schemas.folder import EnsureFoldersRequest
    from apps.api.services.folder_paths import lock_project_folders

    c = committed
    deleting = Session(c.engine)
    lock_project_folders(deleting, c.project_id)
    deleting.execute(
        text("UPDATE folders SET deleted_at = now() WHERE id = :id"), {"id": c.parent_id},
    )

    def ensure(s):
        user = s.get(User, c.user_id)
        body = EnsureFoldersRequest(parent_id=c.parent_id, paths=[["New"]])
        try:
            return ensure_folders(c.project_id, body, db=s, current_user=user)
        except HTTPException as e:
            return e

    thread, pid, result = _in_thread(c.engine, ensure)
    try:
        assert _wait_until_blocked(c.engine, pid.get(timeout=10), thread), \
            "ensure did not wait for the delete in flight"
        deleting.commit()
        thread.join(timeout=10)
        assert not thread.is_alive()
        got = result.get(timeout=1)
    finally:
        deleting.close()

    assert isinstance(got, HTTPException), got
    assert got.status_code == 400 and got.detail["code"] == "folder_not_in_project"
    assert _live_folders(c.engine, c.project_id) == []


def test_a_delete_waits_for_an_ensure_in_flight_and_trashes_what_it_made(committed):
    """The other order: ensure has made folders inside P but not committed.
    Deleting P must wait for it and then trash those folders as well, rather
    than list P's contents too early and leave them live inside the trash."""
    from apps.api.routers.folders import delete_folder
    from apps.api.services.folder_paths import ensure_folder_paths

    c = committed
    ensuring = Session(c.engine)
    made = ensure_folder_paths(ensuring, c.project_id, c.parent_id, [("New", "Inner")],
                               c.user_id)

    def delete(s):
        delete_folder(c.parent_id, db=s, current_user=s.get(User, c.user_id))

    thread, pid, result = _in_thread(c.engine, delete)
    try:
        assert _wait_until_blocked(c.engine, pid.get(timeout=10), thread), \
            "the delete did not wait for the ensure in flight"
        ensuring.commit()
        thread.join(timeout=10)
        assert not thread.is_alive()
        got = result.get(timeout=1)
        assert not isinstance(got, Exception), got
    finally:
        ensuring.close()

    assert made[("New", "Inner")] is not None
    assert _live_folders(c.engine, c.project_id) == []
