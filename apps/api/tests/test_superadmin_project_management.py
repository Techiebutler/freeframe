"""A superadmin managing someone else's project.

The membership endpoints and the rename are owner tier, which an administrator
reaches past their own membership. Real Postgres over HTTP, for the reason the
storage half of these tests gives. Harness shared, in conftest.
"""
import uuid

import pytest

from apps.api.models.project import ProjectMember, ProjectRole

# ── a superadmin managing someone else's project ──────────────────────────────

@pytest.mark.parametrize(
    "who", ["admin", "outsider"], ids=["a superadmin may", "an outsider may not"],
)
def test_who_adds_changes_removes_a_member_and_renames_a_project(
    seed, as_user, admin, monkeypatch, who,
):
    """Every membership endpoint and the rename are owner tier, which a superadmin reaches
    past their own membership and an outsider never does."""
    is_admin = who == "admin"
    sent = []
    monkeypatch.setattr(
        "apps.api.routers.projects.send_task_safe",
        lambda task, **kw: sent.append(kw) if is_admin else pytest.fail(
            "an outsider must not send mail",
        ),
    )
    owner = seed.user()
    project = seed.project(owner, name="old name")
    member = seed.user()
    seed.member(project, member, ProjectRole.viewer)
    newcomer = seed.user(name="New Person")
    client = as_user(admin if is_admin else seed.user())
    ok = 200 if is_admin else 403
    added = client.post(f"/projects/{project.id}/members", json={
        "user_id": str(newcomer.id), "role": "editor",
    })
    assert added.status_code == (201 if is_admin else 403)
    if is_admin:
        assert added.json()["role"] == "editor"
        # Behaviour left exactly as for an owner: adding a member emails them.
        assert [m["to_email"] for m in sent] == [newcomer.email]
    changed = client.patch(
        f"/projects/{project.id}/members/{member.id}", json={"role": "editor"},
    )
    assert changed.status_code == ok
    if is_admin:
        assert changed.json()["role"] == "editor"
    removed = client.delete(f"/projects/{project.id}/members/{member.id}")
    assert removed.status_code == (204 if is_admin else 403)
    row = seed.db.query(ProjectMember).filter(
        ProjectMember.project_id == project.id, ProjectMember.user_id == member.id,
    ).one()
    assert (row.deleted_at is not None) is is_admin
    renamed = client.patch(f"/projects/{project.id}", json={"name": "new name"})
    assert renamed.status_code == ok
    if is_admin:
        assert renamed.json()["name"] == "new name"


@pytest.mark.parametrize("how", ["remove", "demote"])
def test_the_last_owner_is_protected(seed, as_user, admin, how):
    """Every membership-editing endpoint is owner tier, so an ownerless project locks its own
    people out of their settings. Demoting the last owner leaves the same ownerless project
    behind as removing them; with a second owner in place, either is allowed."""
    owner = seed.user()
    project = seed.project(owner)
    client = as_user(admin)

    def _try():
        if how == "remove":
            return client.delete(f"/projects/{project.id}/members/{owner.id}")
        return client.patch(
            f"/projects/{project.id}/members/{owner.id}", json={"role": "editor"},
        )
    refused = _try()
    assert refused.status_code == 400
    assert "only owner" in refused.json()["detail"]
    seed.member(project, seed.user(), ProjectRole.owner)
    assert _try().status_code in (200, 204)


@pytest.mark.parametrize("how", ["remove", "demote"])
def test_a_deactivated_co_owner_does_not_count_as_the_second_owner(seed, as_user, admin, how):
    """The guard keeps an owner who can still sign in, not an owner row.

    A deactivated account is refused at sign-in, so a project whose only other owner is
    deactivated is as ownerless as one with a single owner: its members would be locked
    out of their own settings with no way back from inside. Reactivating the account
    makes it count again, which is the same check from the other side.
    """
    from apps.api.models.user import UserStatus

    owner = seed.user()
    project = seed.project(owner)
    gone = seed.user()
    seed.member(project, gone, ProjectRole.owner)
    gone.status = UserStatus.deactivated
    seed.db.flush()
    client = as_user(admin)

    def _try():
        if how == "remove":
            return client.delete(f"/projects/{project.id}/members/{owner.id}")
        return client.patch(
            f"/projects/{project.id}/members/{owner.id}", json={"role": "editor"},
        )
    refused = _try()
    assert refused.status_code == 400
    assert "only owner" in refused.json()["detail"]
    gone.status = UserStatus.active
    seed.db.flush()
    assert _try().status_code in (200, 204)


@pytest.mark.parametrize("how", ["remove", "demote"])
def test_a_deactivated_sole_owner_is_still_protected(seed, as_user, admin, how):
    """A deactivated owner who is the only owner keeps the project: the guard asks whether
    anyone *else* would be left, not whether the target is the only live owner.

    Leaving deactivated accounts out of the live owners must not turn "no other owner" into
    "nothing to protect". Without that, an administrator removing or demoting the sole owner
    would leave the project with no owner row at all, and reactivating the account would no
    longer give the project its owner back. Adding a live owner first lifts the refusal.
    """
    from apps.api.models.project import ProjectMember
    from apps.api.models.user import UserStatus

    owner = seed.user()
    project = seed.project(owner)
    owner.status = UserStatus.deactivated
    seed.db.flush()
    client = as_user(admin)

    def _try():
        if how == "remove":
            return client.delete(f"/projects/{project.id}/members/{owner.id}")
        return client.patch(
            f"/projects/{project.id}/members/{owner.id}", json={"role": "editor"},
        )

    refused = _try()
    assert refused.status_code == 400
    assert "only owner" in refused.json()["detail"]

    def live_owner_rows():
        return seed.db.query(ProjectMember).filter(
            ProjectMember.project_id == project.id,
            ProjectMember.role == ProjectRole.owner,
            ProjectMember.deleted_at.is_(None),
        ).count()

    assert live_owner_rows() == 1

    # The way out stays open: appoint a live owner, then the deactivated one may go.
    successor = seed.user(name="Successor")
    added = client.post(f"/projects/{project.id}/members", json={
        "user_id": str(successor.id), "role": "owner",
    })
    assert added.status_code == 201
    assert _try().status_code in (200, 204)
    assert live_owner_rows() == 1


# ── two owners removing each other at the same moment ─────────────────────────

@pytest.fixture
def two_owners():
    """Two owners of one project, committed, because the race needs two real
    connections that each see the other's commit. Removed again afterwards."""
    from apps.api.database import SessionLocal
    from apps.api.models.project import Project
    from apps.api.models.user import User, UserStatus

    tag = uuid.uuid4().hex[:8]
    s = SessionLocal()
    users, projects = [], []
    try:
        def user(name):
            u = User(id=uuid.uuid4(), email=f"owners-{name}-{tag}@example.test", name=name,
                     status=UserStatus.active, is_superadmin=False)
            s.add(u)
            users.append(u.id)
            return u

        a, b = user("a"), user("b")
        s.flush()
        project = Project(id=uuid.uuid4(), name=f"P-{tag}", created_by=a.id, is_public=False)
        s.add(project)
        projects.append(project.id)
        s.flush()
        s.add_all([
            ProjectMember(project_id=project.id, user_id=a.id, role=ProjectRole.owner),
            ProjectMember(project_id=project.id, user_id=b.id, role=ProjectRole.owner),
        ])
        s.commit()
        yield {"a": a.id, "b": b.id, "project": project.id}
    finally:
        s.rollback()
        s.query(ProjectMember).filter(
            ProjectMember.project_id.in_(projects),
        ).delete(synchronize_session=False)
        s.query(Project).filter(Project.id.in_(projects)).delete(synchronize_session=False)
        s.query(User).filter(User.id.in_(users)).delete(synchronize_session=False)
        s.commit()
        s.close()


def test_two_owners_removing_each_other_at_once_leave_one_owner(two_owners, monkeypatch):
    """The last-owner guard checks and then writes, so without a lock on the owner rows both
    requests count {A, B}, both pass, and the project ends with no owner.

    Two real requests on their own sessions, held between the check and the write until each
    has passed it. With the owner rows locked the second request waits for the first to
    commit, counts again, finds only its own target left, and is refused; the hold then
    simply times out for the first. Exactly one removal succeeds.
    """
    import threading
    from concurrent.futures import ThreadPoolExecutor
    from unittest.mock import MagicMock, patch

    from fastapi.testclient import TestClient

    from apps.api.database import SessionLocal
    from apps.api.routers import projects as projects_router
    from apps.api.services.auth_service import create_access_token

    with patch("apps.api.services.s3_service.ensure_bucket_exists"), \
         patch("apps.api.services.s3_service.get_s3_client", return_value=MagicMock()):
        from apps.api.main import app

    both_checked = threading.Barrier(2)
    guard = projects_router._refuse_losing_last_owner

    def check_then_hold(*args, **kwargs):
        guard(*args, **kwargs)
        try:
            both_checked.wait(timeout=3)
        except threading.BrokenBarrierError:
            pass  # the other request is waiting on the lock, which is the point

    monkeypatch.setattr(projects_router, "_refuse_losing_last_owner", check_then_hold)
    project = two_owners["project"]

    def remove(actor, target):
        client = TestClient(app, raise_server_exceptions=False)
        token = create_access_token(str(two_owners[actor]))
        return client.delete(
            f"/projects/{project}/members/{two_owners[target]}",
            headers={"Authorization": f"Bearer {token}"},
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = pool.submit(remove, "a", "b"), pool.submit(remove, "b", "a")
        results = [first.result(timeout=60), second.result(timeout=60)]

    assert sorted(r.status_code for r in results) == [204, 400]
    assert all(
        "only owner" in r.json()["detail"] for r in results if r.status_code == 400
    )
    check = SessionLocal()
    try:
        owners = check.query(ProjectMember).filter(
            ProjectMember.project_id == project,
            ProjectMember.role == ProjectRole.owner,
            ProjectMember.deleted_at.is_(None),
        ).count()
    finally:
        check.close()
    assert owners == 1


# ── a target promoted while its demotion is in flight ──────────────────────────

@pytest.fixture
def owner_and_editor():
    """One owner and one editor of a project, committed (two real connections have to
    see each other's commits). Removed again afterwards."""
    from apps.api.database import SessionLocal
    from apps.api.models.project import Project
    from apps.api.models.user import User, UserStatus

    tag = uuid.uuid4().hex[:8]
    s = SessionLocal()
    users, projects = [], []
    try:
        def user(name):
            u = User(id=uuid.uuid4(), email=f"stale-{name}-{tag}@example.test", name=name,
                     status=UserStatus.active, is_superadmin=False)
            s.add(u)
            users.append(u.id)
            return u

        a, z = user("a"), user("z")
        s.flush()
        project = Project(id=uuid.uuid4(), name=f"P-{tag}", created_by=a.id, is_public=False)
        s.add(project)
        projects.append(project.id)
        s.flush()
        s.add_all([
            ProjectMember(project_id=project.id, user_id=a.id, role=ProjectRole.owner),
            ProjectMember(project_id=project.id, user_id=z.id, role=ProjectRole.editor),
        ])
        s.commit()
        yield {"a": a.id, "z": z.id, "project": project.id}
    finally:
        s.rollback()
        s.query(ProjectMember).filter(
            ProjectMember.project_id.in_(projects),
        ).delete(synchronize_session=False)
        s.query(Project).filter(Project.id.in_(projects)).delete(synchronize_session=False)
        s.query(User).filter(User.id.in_(users)).delete(synchronize_session=False)
        s.commit()
        s.close()


def test_a_target_promoted_during_its_demotion_cannot_empty_the_project(
    owner_and_editor,
):
    """The decision whether a change needs the last-owner guard depends on the target's role,
    so the role has to be read after the owner rows are locked, not before.

    Owner A, editor Z. Request 1 demotes Z (an editor, so it needs no guard) and is held
    between its checks and its write. Meanwhile Z is promoted to owner (request 2) and Z
    removes A (request 3). Read before the lock, request 1 still believes Z is an editor,
    request 3 sees {A, Z} and passes, and request 1's write then leaves the project with no
    owner. With the owner rows locked first, requests 2 and 3 queue behind request 1 and
    count again once it has committed.

    The interleaving is held, not timed: each follower is given until it has either finished
    or is seen waiting on a row lock in pg_stat_activity, and only then is request 1 released.
    """
    import threading
    import time

    from fastapi.testclient import TestClient
    from sqlalchemy import event, text

    from apps.api.database import SessionLocal, engine
    from apps.api.services.auth_service import create_access_token

    from unittest.mock import MagicMock, patch

    with patch("apps.api.services.s3_service.ensure_bucket_exists"), \
         patch("apps.api.services.s3_service.get_s3_client", return_value=MagicMock()):
        from apps.api.main import app

    project, a, z = owner_and_editor["project"], owner_and_editor["a"], owner_and_editor["z"]
    at_write, release = threading.Event(), threading.Event()

    def hold_first_write(conn, cursor, statement, parameters, context, executemany):
        # The demotion is the only write that sets the role `viewer`; the request runs on a
        # worker thread of its own, so the statement is told apart by what it writes.
        if (statement.lstrip().upper().startswith("UPDATE PROJECT_MEMBERS")
                and "viewer" in str(parameters) and not at_write.is_set()):
            at_write.set()
            release.wait(30)

    def lock_waiters():
        s = SessionLocal()
        try:
            return s.execute(text(
                "select count(*) from pg_stat_activity where datname = current_database() "
                "and wait_event_type = 'Lock' and query ilike '%project_members%'"
            )).scalar()
        finally:
            s.close()

    def call(actor, method, path, **kw):
        client = TestClient(app, raise_server_exceptions=False)
        token = create_access_token(str(actor))
        return client.request(method, path, headers={"Authorization": f"Bearer {token}"}, **kw)

    results, threads = {}, []

    def start(name, *args, **kw):
        t = threading.Thread(
            target=lambda: results.setdefault(name, call(*args, **kw)), name=name,
        )
        threads.append(t)
        t.start()
        return t

    def settle(t, already_waiting):
        """Until `t` has finished, or one more request than before is waiting on a lock."""
        deadline = time.time() + 5
        while time.time() < deadline and t.is_alive() and lock_waiters() <= already_waiting:
            time.sleep(0.02)

    member = f"/projects/{project}/members"
    event.listen(engine, "before_cursor_execute", hold_first_write)
    try:
        demote = start("demote", a, "PATCH", f"{member}/{z}", json={"role": "viewer"})
        assert at_write.wait(10), "the demotion never reached its write"
        promote = start("promote", a, "PATCH", f"{member}/{z}", json={"role": "owner"})
        settle(promote, 0)
        remove = start("remove", z, "DELETE", f"{member}/{a}")
        settle(remove, lock_waiters() if promote.is_alive() else 0)
        release.set()
        for t in threads:
            t.join(30)
        assert not any(t.is_alive() for t in threads)
    finally:
        release.set()
        event.remove(engine, "before_cursor_execute", hold_first_write)

    check = SessionLocal()
    try:
        owners = check.query(ProjectMember).filter(
            ProjectMember.project_id == project,
            ProjectMember.role == ProjectRole.owner,
            ProjectMember.deleted_at.is_(None),
        ).count()
    finally:
        check.close()

    statuses = {name: r.status_code for name, r in results.items()}
    assert all(code < 500 for code in statuses.values()), statuses
    assert statuses["demote"] == 200, statuses
    assert owners >= 1, statuses


def test_the_target_is_read_fresh_even_when_the_session_already_holds_it(real_db):
    """The permission check loads the caller's own membership before the owner rows are
    locked, so for a caller changing their own membership the session already holds a copy.
    The read after the lock has to return the row as it is now, not that copy."""
    from sqlalchemy import text

    from apps.api.models.project import Project
    from apps.api.models.user import User, UserStatus
    from apps.api.routers.projects import _current_member

    tag = uuid.uuid4().hex[:8]
    user = User(id=uuid.uuid4(), email=f"fresh-{tag}@example.test", name="fresh",
                status=UserStatus.active, is_superadmin=False)
    real_db.add(user)
    real_db.flush()
    project = Project(id=uuid.uuid4(), name=f"P-{tag}", created_by=user.id, is_public=False)
    real_db.add(project)
    real_db.flush()
    held = ProjectMember(project_id=project.id, user_id=user.id, role=ProjectRole.owner)
    real_db.add(held)
    real_db.flush()
    assert held.role == ProjectRole.owner  # loaded into the session

    # Another request's committed change, which the session's copy does not know about.
    real_db.execute(
        text("UPDATE project_members SET role = 'viewer' WHERE id = :id"), {"id": held.id},
    )

    current = _current_member(real_db, project.id, user.id)
    assert current is not None and current.role == ProjectRole.viewer
