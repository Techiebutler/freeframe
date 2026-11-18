"""An open SSE stream keeps checking that its subscriber may see the project.

GET /events/{project_id} used to check access once, at connect, and then stream
for as long as the connection stayed up. Losing access afterwards (removed from
the project, deactivated, deleted, password changed, token expired, project made
private or deleted) did not stop the events.

These drive the real endpoint function and the real event_stream generator
against a real Postgres. Rows are committed, because the endpoint checks on its
own sessions and cannot see the `real_db` fixture's uncommitted transaction;
each test cleans up after itself. Only Redis is replaced, by an in-memory
pub/sub that keeps redis-py's get_message() contract (timeout defaults to 0 and
returns None when nothing is waiting), because CI has no Redis service.
"""
import asyncio
import json
import time
import uuid
from datetime import datetime, timezone

import jwt
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from apps.api.config import settings
from apps.api.database import SessionLocal
from apps.api.models.project import Project, ProjectMember, ProjectRole
from apps.api.models.user import User, UserStatus
from apps.api.routers import events
from apps.api.services import event_service
from apps.api.services.auth_service import create_access_token, create_refresh_token
from apps.api.services.permissions import project_events_denial


# ── in-memory stand-in for Redis pub/sub ──────────────────────────────────────

class _FakePubSub:
    def __init__(self, broker):
        self.broker = broker
        self.queue: asyncio.Queue = asyncio.Queue()
        self.channels: set[str] = set()
        self.get_message_calls = 0

    async def subscribe(self, channel):
        self.channels.add(channel)
        self.broker.subscribers.append(self)

    async def get_message(self, ignore_subscribe_messages=False, timeout=0.0):
        self.get_message_calls += 1
        # A real read always goes through the event loop, even with timeout=0.
        await asyncio.sleep(0)
        try:
            if timeout is None:
                return await self.queue.get()
            if timeout <= 0:
                return self.queue.get_nowait()
            return await asyncio.wait_for(self.queue.get(), timeout)
        except (asyncio.QueueEmpty, asyncio.TimeoutError):
            return None

    async def unsubscribe(self, channel):
        self.channels.discard(channel)

    async def aclose(self):
        self.broker.closed += 1


class _FakeBroker:
    def __init__(self):
        self.subscribers: list[_FakePubSub] = []
        self.closed = 0

    def pubsub(self):
        return _FakePubSub(self)

    def publish(self, project_id, event_type, payload):
        """Exactly what publish_sync puts on the wire."""
        channel = event_service._channel(project_id)
        data = event_service._encode(event_type, payload)
        for sub in self.subscribers:
            if channel in sub.channels:
                sub.queue.put_nowait({"type": "message", "channel": channel, "data": data})


@pytest.fixture
def broker(monkeypatch):
    b = _FakeBroker()
    monkeypatch.setattr(event_service, "_get_redis", lambda: b)
    return b


@pytest.fixture
def timing(monkeypatch):
    """Default: check before every event, and never on the idle timer."""
    def set_(max_age=0.0, recheck=30.0):
        monkeypatch.setattr(settings, "sse_auth_max_age_seconds", max_age)
        monkeypatch.setattr(settings, "sse_auth_recheck_seconds", recheck)
    set_()
    return set_


# ── committed fixtures ────────────────────────────────────────────────────────

@pytest.fixture
def world():
    """Owner and viewer on private project P, an outsider, public project Q, and
    private project R that all three are members of. R is what makes a
    membership elsewhere count for nothing on P."""
    tag = uuid.uuid4().hex[:8]
    s = SessionLocal()
    users, projects = [], []
    try:
        def user(name):
            u = User(id=uuid.uuid4(), email=f"sse-{name}-{tag}@example.test", name=name,
                     status=UserStatus.active, is_superadmin=False)
            s.add(u)
            users.append(u.id)
            return u

        owner, member, outsider = user("owner"), user("member"), user("outsider")
        s.flush()
        P = Project(id=uuid.uuid4(), name=f"P-{tag}", created_by=owner.id, is_public=False)
        Q = Project(id=uuid.uuid4(), name=f"Q-{tag}", created_by=owner.id, is_public=True)
        R = Project(id=uuid.uuid4(), name=f"R-{tag}", created_by=owner.id, is_public=False)
        s.add_all([P, Q, R])
        projects += [P.id, Q.id, R.id]
        s.flush()
        s.add_all([
            ProjectMember(project_id=P.id, user_id=owner.id, role=ProjectRole.owner),
            ProjectMember(project_id=P.id, user_id=member.id, role=ProjectRole.viewer),
            ProjectMember(project_id=Q.id, user_id=owner.id, role=ProjectRole.owner),
            ProjectMember(project_id=R.id, user_id=owner.id, role=ProjectRole.owner),
            ProjectMember(project_id=R.id, user_id=member.id, role=ProjectRole.viewer),
            ProjectMember(project_id=R.id, user_id=outsider.id, role=ProjectRole.viewer),
        ])
        s.commit()
        yield {"owner": owner.id, "member": member.id, "outsider": outsider.id,
               "P": P.id, "Q": Q.id, "R": R.id}
    finally:
        s.rollback()
        s.query(ProjectMember).filter(ProjectMember.project_id.in_(projects)).delete(synchronize_session=False)
        s.query(Project).filter(Project.id.in_(projects)).delete(synchronize_session=False)
        s.query(User).filter(User.id.in_(users)).delete(synchronize_session=False)
        s.commit()
        s.close()


def _write(fn):
    """Apply a change the way the API's endpoints do: on its own committed session."""
    s = SessionLocal()
    try:
        fn(s)
        s.commit()
    finally:
        s.close()


def _now():
    return datetime.now(timezone.utc)


# The same column writes the real endpoints make (checked end to end over
# HTTP separately): DELETE /projects/{id}/members/{uid}, PATCH
# /admin/users/{id}/deactivate, DELETE /users/{id}, PATCH /auth/change-password,
# PATCH /projects/{id} {is_public: false}, DELETE /projects/{id}.
def _remove_member(w):
    _write(lambda s: s.query(ProjectMember).filter(
        ProjectMember.project_id == w["P"], ProjectMember.user_id == w["member"],
    ).update({ProjectMember.deleted_at: _now()}))


def _deactivate(w):
    _write(lambda s: s.query(User).filter(User.id == w["member"]).update(
        {User.status: UserStatus.deactivated}))


def _delete_user(w):
    _write(lambda s: s.query(User).filter(User.id == w["member"]).update(
        {User.status: UserStatus.deactivated, User.deleted_at: _now()}))


def _soft_delete_active_user(w):
    # DELETE /users/{id} refuses an active user today, so this state is not
    # reachable through the API; it pins the deleted_at filter on its own.
    _write(lambda s: s.query(User).filter(User.id == w["member"]).update({User.deleted_at: _now()}))


def _bump_token_version(w):
    _write(lambda s: s.query(User).filter(User.id == w["member"]).update(
        {User.token_version: User.token_version + 1}))


def _make_private(w):
    _write(lambda s: s.query(Project).filter(Project.id == w["Q"]).update({Project.is_public: False}))


def _delete_project(w):
    _write(lambda s: s.query(Project).filter(Project.id == w["P"]).update({Project.deleted_at: _now()}))


# (label, who streams, which project, how it is revoked, expected reason, via bearer header)
REVOCATIONS = [
    ("member removed", "member", "P", _remove_member, "access_revoked", False),
    ("user deactivated", "member", "P", _deactivate, "access_revoked", False),
    ("user deleted", "member", "P", _delete_user, "access_revoked", False),
    ("user row soft-deleted", "member", "P", _soft_delete_active_user, "access_revoked", False),
    ("password changed", "member", "P", _bump_token_version, "token_revoked", True),
    ("project made private", "outsider", "Q", _make_private, "access_revoked", False),
    ("project deleted", "member", "P", _delete_project, "access_revoked", False),
]
IDS = [r[0] for r in REVOCATIONS]


# ── driving the stream ────────────────────────────────────────────────────────

def _token(user_id, exp_in=None, exp_at=None):
    if exp_in is None and exp_at is None:
        return create_access_token(str(user_id))
    exp = exp_at if exp_at is not None else int(time.time() + exp_in)
    return jwt.encode({"sub": str(user_id), "type": "access", "ver": 1, "exp": exp},
                      settings.jwt_secret, algorithm=settings.jwt_algorithm)


async def _open(project_id, token, bearer=False):
    if bearer:
        creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
        resp = await events.stream_events(project_id=project_id, token=None, credentials=creds)
    else:
        resp = await events.stream_events(project_id=project_id, token=token, credentials=None)
    return resp.body_iterator


async def _next(gen, timeout=3.0):
    return await asyncio.wait_for(gen.__anext__(), timeout)


async def _deliver(gen, broker, project_id, event_type, payload):
    """Publish while the stream is waiting, return what it yields next."""
    pending = asyncio.ensure_future(gen.__anext__())
    await asyncio.sleep(0.05)  # let it subscribe and block on get_message
    broker.publish(project_id, event_type, payload)
    return await asyncio.wait_for(pending, 3.0)


def _event(chunk):
    lines = dict(line.split(": ", 1) for line in chunk.strip().split("\n"))
    return lines["event"], json.loads(lines["data"])


async def _assert_ended(gen):
    with pytest.raises(StopAsyncIteration):
        await _next(gen)


# ── tests ─────────────────────────────────────────────────────────────────────

def test_an_authorized_member_keeps_receiving_events_and_keepalives(world, broker, timing):
    timing(max_age=0.0, recheck=0.2)

    async def scenario():
        gen = await _open(world["P"], _token(world["member"]))
        first = await _deliver(gen, broker, world["P"], "new_comment", {"comment_id": "c1"})
        assert _event(first) == ("new_comment", {"comment_id": "c1"})
        # idle past the recheck interval: the check passes, a keepalive is sent
        assert await _next(gen) == ": keepalive\n\n"
        second = await _deliver(gen, broker, world["P"], "transcode_complete", {"asset_id": "a1"})
        assert _event(second) == ("transcode_complete", {"asset_id": "a1"})
        await gen.aclose()

    asyncio.run(scenario())
    assert broker.closed == 1  # the subscription is torn down when the stream ends


@pytest.mark.parametrize("label,who,proj,revoke,reason,bearer", REVOCATIONS, ids=IDS)
def test_revoked_subscriber_gets_no_further_events_and_the_stream_ends(
        world, broker, timing, label, who, proj, revoke, reason, bearer):
    async def scenario():
        gen = await _open(world[proj], _token(world[who]), bearer=bearer)
        live = await _deliver(gen, broker, world[proj], "new_comment", {"comment_id": "before"})
        assert _event(live) == ("new_comment", {"comment_id": "before"})

        revoke(world)

        after = await _deliver(gen, broker, world[proj], "new_comment", {"comment_id": "after"})
        assert _event(after) == ("revoked", {"reason": reason})
        await _assert_ended(gen)

    asyncio.run(scenario())


def test_expired_token_gets_no_further_events_and_the_stream_ends(world, broker, timing):
    async def scenario():
        gen = await _open(world["P"], _token(world["member"], exp_in=2))
        live = await _deliver(gen, broker, world["P"], "new_comment", {"comment_id": "before"})
        assert _event(live)[0] == "new_comment"
        await asyncio.sleep(2.1)
        after = await _deliver(gen, broker, world["P"], "new_comment", {"comment_id": "after"})
        assert _event(after) == ("revoked", {"reason": "token_expired"})
        await _assert_ended(gen)

    asyncio.run(scenario())


@pytest.mark.parametrize("label,who,proj,revoke,reason,bearer", REVOCATIONS, ids=IDS)
def test_an_idle_revoked_stream_is_closed_on_the_keepalive_tick(
        world, broker, timing, label, who, proj, revoke, reason, bearer):
    """Nothing is published at all: the timer alone must end the stream."""
    timing(max_age=0.0, recheck=0.3)

    async def scenario():
        gen = await _open(world[proj], _token(world[who]), bearer=bearer)
        assert await _next(gen) == ": keepalive\n\n"  # still allowed on the first tick
        revoke(world)
        assert _event(await _next(gen)) == ("revoked", {"reason": reason})
        await _assert_ended(gen)

    asyncio.run(scenario())


def test_an_idle_stream_is_closed_once_its_token_expires(world, broker, timing):
    timing(max_age=0.0, recheck=0.3)

    async def scenario():
        gen = await _open(world["P"], _token(world["member"], exp_in=2))
        chunk = await _next(gen)
        for _ in range(20):  # 0.3s ticks; the token lasts at most 2s
            if chunk != ": keepalive\n\n":
                break
            chunk = await _next(gen)
        assert _event(chunk) == ("revoked", {"reason": "token_expired"})
        await _assert_ended(gen)

    asyncio.run(scenario())


@pytest.mark.parametrize("label,who,proj,revoke,reason,bearer", REVOCATIONS, ids=IDS)
def test_a_new_connection_is_refused_after_revocation(
        world, broker, timing, label, who, proj, revoke, reason, bearer):
    """Refused with 403 rather than opened and then revoked, so a client's
    reconnect backoff is not reset by a stream that only says goodbye.
    `project deleted` was accepted before this fix."""
    revoke(world)

    async def scenario():
        with pytest.raises(HTTPException) as exc:
            await _open(world[proj], _token(world[who]), bearer=bearer)
        assert exc.value.status_code == 403

    asyncio.run(scenario())
    assert broker.subscribers == []  # never subscribed


def test_a_connection_without_a_valid_access_token_is_refused(world, broker, timing):
    async def scenario():
        refresh = create_refresh_token(str(world["member"]))
        for token in (_token(world["member"], exp_in=-5), "not-a-jwt", refresh, None):
            with pytest.raises(HTTPException) as exc:
                await _open(world["P"], token)
            assert exc.value.status_code == 403

    asyncio.run(scenario())


def test_a_non_member_cannot_connect_to_a_private_project(world, broker, timing):
    async def scenario():
        with pytest.raises(HTTPException) as exc:
            await _open(world["P"], _token(world["outsider"]))
        assert exc.value.status_code == 403
        # ...but may stream a public one
        gen = await _open(world["Q"], _token(world["outsider"]))
        live = await _deliver(gen, broker, world["Q"], "new_comment", {"comment_id": "q"})
        assert _event(live)[0] == "new_comment"
        await gen.aclose()

    asyncio.run(scenario())


def test_an_idle_stream_waits_on_the_broker_between_keepalives(world, broker, timing):
    """redis-py's get_message() returns at once unless given a timeout, so the
    loop must pass one; without it the loop would not wait between keepalives."""
    timing(max_age=0.0, recheck=0.25)

    async def scenario():
        gen = await _open(world["P"], _token(world["member"]))
        loop = asyncio.get_running_loop()
        end = loop.time() + 1.0
        keepalives = 0
        while loop.time() < end:
            assert await _next(gen) == ": keepalive\n\n"
            keepalives += 1
        await gen.aclose()
        return keepalives

    keepalives = asyncio.run(scenario())
    assert 3 <= keepalives <= 5
    assert broker.subscribers[0].get_message_calls <= 3 * keepalives


def test_events_inside_the_max_age_share_one_check(world, broker, timing, monkeypatch):
    """A transcode publishes about a hundred progress events; checking before
    each one would be a query per event per subscriber."""
    timing(max_age=5.0, recheck=30.0)
    calls = []
    real = events.project_events_denial
    monkeypatch.setattr(events, "project_events_denial", lambda *a: calls.append(a) or real(*a))

    async def scenario():
        gen = await _open(world["P"], _token(world["member"]))
        for i in range(20):
            chunk = await _deliver(gen, broker, world["P"], "transcode_progress", {"percent": i})
            assert _event(chunk) == ("transcode_progress", {"percent": i})
        await gen.aclose()

    asyncio.run(scenario())
    assert len(calls) == 1  # the connect check only


def test_a_failing_check_ends_the_stream_without_delivering(world, broker, timing, monkeypatch):
    """Fail closed: if the database cannot answer, the event is not sent. No
    `revoked` either, so the client reconnects and gets a fresh decision."""
    async def scenario():
        gen = await _open(world["P"], _token(world["member"]))
        live = await _deliver(gen, broker, world["P"], "new_comment", {"comment_id": "before"})
        assert _event(live)[0] == "new_comment"

        def down():
            raise ConnectionError("database is down")
        monkeypatch.setattr(events, "SessionLocal", down)

        pending = asyncio.ensure_future(gen.__anext__())
        await asyncio.sleep(0.05)
        broker.publish(world["P"], "new_comment", {"comment_id": "after"})
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(pending, 3.0)

    asyncio.run(scenario())


def test_an_open_stream_holds_no_database_connection_between_checks(world, broker, timing):
    from apps.api.database import engine

    async def scenario():
        before = engine.pool.checkedout()
        gen = await _open(world["P"], _token(world["member"]))
        for i in range(3):  # three re-checks, max age 0
            chunk = await _deliver(gen, broker, world["P"], "transcode_progress", {"percent": i})
            assert _event(chunk)[0] == "transcode_progress"
        held = engine.pool.checkedout() - before
        await gen.aclose()
        return held

    assert asyncio.run(scenario()) == 0


def test_the_endpoint_takes_no_request_scoped_db_session():
    """On FastAPI 0.139+ a `Depends(get_db)` session stays checked out until a
    streaming response finishes, so a request-scoped session would stay checked
    out for the life of the stream. The endpoint opens its own short sessions
    instead."""
    from apps.api.database import get_db

    route = next(r for r in events.router.routes if r.path == "/events/{project_id}")

    def calls(dependant):
        yield dependant.call
        for sub in dependant.dependencies:
            yield from calls(sub)

    assert get_db not in set(calls(route.dependant))


def test_membership_of_another_project_grants_nothing_here(world, broker, timing):
    """The membership test is scoped to the project being streamed: the
    outsider is a member of R, which must not open P."""
    s = SessionLocal()
    try:
        assert project_events_denial(s, world["P"], world["outsider"], 1) == "access_revoked"
        assert project_events_denial(s, world["R"], world["outsider"], 1) is None
    finally:
        s.close()

    async def scenario():
        with pytest.raises(HTTPException) as exc:
            await _open(world["P"], _token(world["outsider"]))
        assert exc.value.status_code == 403
        gen = await _open(world["R"], _token(world["outsider"]))
        live = await _deliver(gen, broker, world["R"], "new_comment", {"comment_id": "r"})
        assert _event(live)[0] == "new_comment"
        await gen.aclose()

    asyncio.run(scenario())


def _counting_checks(monkeypatch):
    calls = []
    real = events.project_events_denial
    monkeypatch.setattr(events, "project_events_denial", lambda *a: calls.append(a) or real(*a))
    return calls


def test_no_event_is_delivered_after_the_token_expires_even_inside_the_max_age(
        world, broker, timing, monkeypatch):
    """Expiry is compared before every write, not only on the gated database
    check, so an event published just after `exp` is not sent even though the
    last check is still fresh enough to deliver on."""
    timing(max_age=60.0, recheck=60.0)
    calls = _counting_checks(monkeypatch)
    exp = int(time.time()) + 2

    async def scenario():
        gen = await _open(world["P"], _token(world["member"], exp_at=exp))
        live = await _deliver(gen, broker, world["P"], "new_comment", {"comment_id": "before"})
        assert _event(live)[0] == "new_comment"
        await asyncio.sleep(max(0.0, exp - time.time()) + 0.05)
        after = await _deliver(gen, broker, world["P"], "new_comment", {"comment_id": "after"})
        assert _event(after) == ("revoked", {"reason": "token_expired"})
        await _assert_ended(gen)

    asyncio.run(scenario())
    assert len(calls) == 1  # the connect check only: expiry needed no query


def test_an_idle_stream_is_closed_when_its_token_expires_not_on_the_next_tick(world, broker, timing):
    timing(max_age=60.0, recheck=60.0)
    exp = int(time.time()) + 2

    async def scenario():
        gen = await _open(world["P"], _token(world["member"], exp_at=exp))
        chunk = await _next(gen, timeout=4.0)  # long before the 30 s keepalive
        assert _event(chunk) == ("revoked", {"reason": "token_expired"})
        assert time.time() >= exp
        await _assert_ended(gen)

    asyncio.run(scenario())


def test_keepalives_do_not_follow_a_long_recheck_interval(world, broker, timing, monkeypatch):
    """Raising SSE_AUTH_RECHECK_SECONDS past a proxy's read timeout must not
    leave an idle stream silent long enough to be dropped: the keepalive is
    capped at KEEPALIVE_MAX_SECONDS whatever the recheck interval."""
    assert event_service.KEEPALIVE_MAX_SECONDS <= 30.0
    monkeypatch.setattr(event_service, "KEEPALIVE_MAX_SECONDS", 0.2)
    timing(max_age=0.0, recheck=60.0)
    calls = _counting_checks(monkeypatch)

    async def scenario():
        gen = await _open(world["P"], _token(world["member"]))
        for _ in range(3):
            assert await _next(gen, timeout=1.0) == ": keepalive\n\n"
        await gen.aclose()

    asyncio.run(scenario())
    assert len(calls) == 1  # keepalives alone do not re-run the check


def test_the_age_of_the_first_check_counts_from_the_connect_check(world, broker, timing, monkeypatch):
    """The connect check is the stream's first check, so its age runs from
    when it was made, not from when the response started streaming."""
    timing(max_age=0.3, recheck=60.0)
    calls = _counting_checks(monkeypatch)

    async def scenario():
        gen = await _open(world["P"], _token(world["member"]))
        await asyncio.sleep(0.4)  # the response has not started streaming yet
        chunk = await _deliver(gen, broker, world["P"], "new_comment", {"comment_id": "c"})
        assert _event(chunk)[0] == "new_comment"
        await gen.aclose()

    asyncio.run(scenario())
    assert len(calls) == 2  # connect, then again before the first event
