"""Share-link passwords in the settings API, and the guest sessions they open.

A password link stores a bcrypt hash (what guests are checked against) and a
reversible copy, kept only so the settings panel can show the password back to
the people who manage the link. Guarded here, against a real Postgres through
the real app:

  * GET /share/{token}/details shows `password_value` to owners and editors
    only. Reviewers and viewers can open the panel's data (they need the token
    to copy the link) but get `password_value: null` with `has_password: true`;
  * every response that describes a link reports `has_password` correctly,
    including the create responses and the asset and folder link lists, and
    none of those carry the password itself;
  * changing or clearing a link's password, disabling it, and deleting it end
    the guest sessions opened with the old state, so a session from before a
    password change does not outlive it. A redis outage does not fail the
    change itself;
  * a 422 never echoes a password back, and a password is limited by its
    UTF-8 size, well under what the stored copy's column can hold.
"""
import fnmatch
import logging
import uuid
from unittest.mock import patch

import bcrypt
import pytest
import redis as redis_lib
from sqlalchemy.orm import Session

PW = "first-password-1"
PW2 = "second-password-2"


# ── harness ────────────────────────────────────────────────────────────────────

class FakeRedis:
    """The few redis commands the share-session helpers use, in a dict."""

    def __init__(self):
        self.store = {}

    def setex(self, key, ttl, value):
        self.store[key] = value

    def exists(self, key):
        return int(key in self.store)

    def get(self, key):
        return self.store.get(key)

    def scan_iter(self, match=None, count=None):
        for key in list(self.store):
            if match is None or fnmatch.fnmatchcase(key, match):
                yield key

    def delete(self, *keys):
        return sum(1 for k in keys if self.store.pop(k, None) is not None)

    def sessions(self, token):
        return [k for k in self.store if k.startswith(f"share_session:{token}:")]


@pytest.fixture
def fake_redis(monkeypatch):
    import apps.api.services.redis_service as rs
    fake = FakeRedis()
    monkeypatch.setattr(rs, "get_redis", lambda: fake)
    return fake


@pytest.fixture
def db():
    """A real session where each endpoint commit lands in a SAVEPOINT, so the
    app can commit and the outer transaction still rolls back."""
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
def client(db, fake_redis):
    from fastapi.testclient import TestClient
    from apps.api.main import app
    from apps.api.database import get_db

    with patch("apps.api.services.s3_service.ensure_bucket_exists"):
        app.dependency_overrides[get_db] = lambda: db
        c = TestClient(app, raise_server_exceptions=False)
        # A fresh address per test keeps the per-IP share rate limits out of the way.
        c.headers["x-real-ip"] = f"10.{uuid.uuid4().int % 250}.{uuid.uuid4().int % 250}.{uuid.uuid4().int % 250}"
        yield c
    app.dependency_overrides.clear()


def _auth(user):
    from apps.api.services.auth_service import create_access_token
    return {"Authorization": f"Bearer {create_access_token(str(user.id), user.token_version or 1)}"}


class World:
    pass


@pytest.fixture
def w(db):
    """A project with owner, editor, reviewer and viewer, a folder F holding a
    video asset A, and a stranger who is in no project."""
    from apps.api.models.user import User
    from apps.api.models.project import Project, ProjectType, ProjectMember, ProjectRole
    from apps.api.models.folder import Folder
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, MediaFile, FileType, ProcessingStatus,
    )

    w = World()

    def user(name):
        u = User(email=f"{name}-{uuid.uuid4().hex[:8]}@t.local", name=name)
        db.add(u); db.flush(); db.refresh(u)
        return u

    w.owner, w.editor = user("owner"), user("editor")
    w.reviewer, w.viewer = user("reviewer"), user("viewer")
    w.project = Project(name="P", project_type=ProjectType.team, created_by=w.owner.id)
    db.add(w.project); db.flush()
    for u, role in ((w.owner, ProjectRole.owner), (w.editor, ProjectRole.editor),
                    (w.reviewer, ProjectRole.reviewer), (w.viewer, ProjectRole.viewer)):
        db.add(ProjectMember(project_id=w.project.id, user_id=u.id, role=role))
    w.F = Folder(project_id=w.project.id, name="F", created_by=w.owner.id)
    db.add(w.F); db.flush()
    w.A = Asset(project_id=w.project.id, name="A", asset_type=AssetType.video,
                created_by=w.owner.id, folder_id=w.F.id)
    db.add(w.A); db.flush()
    v = AssetVersion(asset_id=w.A.id, version_number=1, processing_status=ProcessingStatus.ready,
                     created_by=w.owner.id)
    db.add(v); db.flush()
    db.add(MediaFile(version_id=v.id, file_type=FileType.video, original_filename="A.mov",
                     mime_type="video/quicktime", file_size_bytes=1000,
                     s3_key_raw=f"raw/{w.A.id}/A.mov",
                     s3_key_processed=f"processed/{w.A.id}/v1/master.m3u8",
                     s3_key_thumbnail=f"thumbs/{w.A.id}/v1.jpg", duration_seconds=12.0))
    db.flush()
    return w


def _create(client, w, kind, password=PW, user=None):
    """Create a link of `kind` through the API as `user` (the owner by default)."""
    body = {"password": password, "title": kind}
    if kind == "asset":
        path = f"/assets/{w.A.id}/share"
    elif kind == "folder":
        path = f"/folders/{w.F.id}/share"
    elif kind == "project":
        path = f"/projects/{w.project.id}/share"
    elif kind == "multi":
        path = f"/projects/{w.project.id}/share/multi"
        body["asset_ids"] = [str(w.A.id)]
        body["folder_ids"] = [str(w.F.id)]
    else:
        raise AssertionError(kind)
    return client.post(path, json=body, headers=_auth(user or w.owner))


def _link(client, w, kind, password=PW):
    r = _create(client, w, kind, password)
    assert r.status_code == 201, (r.status_code, r.text)
    return r.json()["token"]


KINDS = ["asset", "folder", "project", "multi"]


# ── 1. who sees the password ───────────────────────────────────────────────────

@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("role,sees", [
    ("owner", True), ("editor", True), ("reviewer", False), ("viewer", False),
])
def test_details_show_the_password_to_owners_and_editors_only(client, w, kind, role, sees):
    token = _link(client, w, kind)
    r = client.get(f"/share/{token}/details", headers=_auth(getattr(w, role)))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["has_password"] is True
    assert body["token"] == token  # the token stays visible: the Copy button needs it
    if sees:
        assert body["password_value"] == PW
    else:
        assert body["password_value"] is None
        assert PW not in r.text


def test_details_of_a_link_without_a_password(client, w):
    token = _link(client, w, "asset", password=None)
    for role in ("owner", "viewer"):
        body = client.get(f"/share/{token}/details", headers=_auth(getattr(w, role))).json()
        assert body["has_password"] is False
        assert body["password_value"] is None


def test_patch_response_still_shows_the_new_password_to_the_editor(client, w):
    token = _link(client, w, "asset")
    r = client.patch(f"/share/{token}", json={"password": PW2}, headers=_auth(w.editor))
    assert r.status_code == 200, r.text
    assert r.json()["has_password"] is True
    assert r.json()["password_value"] == PW2


def test_viewer_cannot_change_the_password(client, w):
    token = _link(client, w, "asset")
    r = client.patch(f"/share/{token}", json={"password": PW2}, headers=_auth(w.viewer))
    assert r.status_code == 403


# ── 2. has_password everywhere a link is described ────────────────────────────

@pytest.mark.parametrize("kind", KINDS)
def test_create_responses_report_has_password(client, w, kind):
    r = _create(client, w, kind)
    assert r.status_code == 201, r.text
    assert r.json()["has_password"] is True
    assert r.json()["password_value"] is None
    assert PW not in r.text


@pytest.mark.parametrize("kind", KINDS)
def test_create_without_a_password_reports_none(client, w, kind):
    r = _create(client, w, kind, password=None)
    assert r.status_code == 201, r.text
    assert r.json()["has_password"] is False


def test_asset_link_list_reports_has_password(client, w):
    token = _link(client, w, "asset")
    r = client.get(f"/assets/{w.A.id}/shares", headers=_auth(w.editor))
    assert r.status_code == 200, r.text
    [row] = [x for x in r.json() if x["token"] == token]
    assert row["has_password"] is True
    assert row["password_value"] is None


@pytest.mark.parametrize("role", ["owner", "editor", "reviewer", "viewer"])
def test_folder_link_list_reports_has_password_and_never_the_password(client, w, role):
    token = _link(client, w, "folder")
    r = client.get(f"/folders/{w.F.id}/shares", headers=_auth(getattr(w, role)))
    assert r.status_code == 200, r.text
    [row] = [x for x in r.json() if x["token"] == token]
    assert row["has_password"] is True
    assert row["password_value"] is None
    assert PW not in r.text


# ── 3. guest sessions end with the password they were opened under ─────────────

def _guest_session(client, token, password=PW):
    r = client.post(f"/share/{token}/verify", json={"password": password})
    assert r.status_code == 200, r.text
    return r.json()["share_session"]


def _guest_calls(client, token, w, session):
    q = f"?share_session={session}"
    return (
        client.get(f"/share/{token}/stream/{w.A.id}{q}").status_code,
        client.get(f"/share/{token}/thumbnail/{w.A.id}{q}").status_code,
    )


def test_a_password_change_ends_the_sessions_opened_under_the_old_one(client, w, fake_redis):
    token = _link(client, w, "asset")
    session = _guest_session(client, token)
    assert _guest_calls(client, token, w, session) == (200, 200)

    r = client.patch(f"/share/{token}", json={"password": PW2}, headers=_auth(w.owner))
    assert r.status_code == 200, r.text

    assert _guest_calls(client, token, w, session) == (403, 403)
    assert fake_redis.sessions(token) == []
    # The new password opens a new session as before.
    fresh = _guest_session(client, token, PW2)
    assert _guest_calls(client, token, w, fresh) == (200, 200)


def test_a_session_does_not_survive_disable_and_re_enable(client, w, fake_redis):
    token = _link(client, w, "asset")
    session = _guest_session(client, token)
    assert _guest_calls(client, token, w, session) == (200, 200)

    owner = _auth(w.owner)
    assert client.patch(f"/share/{token}", json={"is_enabled": False}, headers=owner).status_code == 200
    assert fake_redis.sessions(token) == []
    assert client.patch(f"/share/{token}", json={"is_enabled": True}, headers=owner).status_code == 200

    assert _guest_calls(client, token, w, session) == (403, 403)


def test_clearing_the_password_ends_its_sessions(client, w, fake_redis):
    token = _link(client, w, "asset")
    _guest_session(client, token)
    assert fake_redis.sessions(token)
    r = client.patch(f"/share/{token}", json={"password": None}, headers=_auth(w.owner))
    assert r.status_code == 200
    assert r.json()["has_password"] is False
    assert fake_redis.sessions(token) == []


def test_deleting_a_link_ends_its_sessions(client, w, fake_redis):
    token = _link(client, w, "asset")
    session = _guest_session(client, token)
    assert fake_redis.sessions(token)
    assert client.delete(f"/share/{token}", headers=_auth(w.owner)).status_code == 204
    assert fake_redis.sessions(token) == []
    assert _guest_calls(client, token, w, session) == (404, 404)


def test_unrelated_changes_keep_sessions(client, w, fake_redis):
    token = _link(client, w, "asset")
    session = _guest_session(client, token)
    r = client.patch(f"/share/{token}", json={"title": "renamed", "is_enabled": True},
                     headers=_auth(w.owner))
    assert r.status_code == 200
    assert _guest_calls(client, token, w, session) == (200, 200)


def test_another_links_sessions_are_left_alone(client, w, fake_redis):
    t1 = _link(client, w, "asset")
    t2 = _link(client, w, "asset")
    s2 = _guest_session(client, t2)
    assert client.patch(f"/share/{t1}", json={"password": PW2}, headers=_auth(w.owner)).status_code == 200
    assert _guest_calls(client, t2, w, s2) == (200, 200)


class _DownRedis:
    def __getattr__(self, name):
        def fail(*a, **k):
            raise redis_lib.ConnectionError("redis is down")
        return fail


@pytest.mark.parametrize("change", [{"password": PW2}, {"password": None}, {"is_enabled": False}])
def test_a_redis_outage_does_not_fail_the_change(client, w, monkeypatch, caplog, change):
    import apps.api.services.redis_service as rs
    token = _link(client, w, "asset")
    monkeypatch.setattr(rs, "get_redis", lambda: _DownRedis())
    with caplog.at_level(logging.WARNING):
        r = client.patch(f"/share/{token}", json=change, headers=_auth(w.owner))
    assert r.status_code == 200, r.text
    assert any("share session" in rec.getMessage().lower() for rec in caplog.records)


def test_a_redis_outage_does_not_fail_the_delete(client, w, monkeypatch):
    import apps.api.services.redis_service as rs
    token = _link(client, w, "asset")

    def boom():
        raise redis_lib.ConnectionError("redis is down")
    monkeypatch.setattr(rs, "get_redis", boom)
    assert client.delete(f"/share/{token}", headers=_auth(w.owner)).status_code == 204


def test_delete_share_sessions_matches_only_that_token(fake_redis):
    from apps.api.services.redis_service import delete_share_sessions
    fake_redis.setex("share_session:abc:s1", 60, "1")
    fake_redis.setex("share_session:abc:s2", 60, "1")
    fake_redis.setex("share_session:abcd:s3", 60, "1")
    fake_redis.setex("other:abc:s4", 60, "1")
    delete_share_sessions("abc")
    assert sorted(fake_redis.store) == ["other:abc:s4", "share_session:abcd:s3"]


def test_delete_share_sessions_escapes_glob_characters(fake_redis):
    """Tokens are token_urlsafe today, so this is belt and braces: a `*` in a
    token must not widen the match to every link."""
    from apps.api.services.redis_service import _redis_glob_escape
    assert _redis_glob_escape("a*b?c[d]e\\f") == "a\\*b\\?c\\[d\\]e\\\\f"
    assert _redis_glob_escape("Ab-_09") == "Ab-_09"


# ── 5. a 422 never echoes a password ───────────────────────────────────────────

SECRET = "zz-secret-value-77"


@pytest.mark.parametrize("body", [
    {"password": 12345678901},
    {"password": [SECRET]},
    {"password": {"x": SECRET}},
    {"pw": SECRET},
    SECRET,
    [SECRET],
])
def test_verify_422_does_not_echo_the_body(client, w, body):
    token = _link(client, w, "asset")
    r = client.post(f"/share/{token}/verify", json=body)
    assert r.status_code == 422, r.text
    assert SECRET not in r.text
    assert "12345678901" not in r.text
    # Still the usual shape, so clients reading `detail` keep working.
    detail = r.json()["detail"]
    assert detail and all({"type", "loc", "msg"} <= set(e) for e in detail)


@pytest.mark.parametrize("kind", KINDS)
def test_create_422_does_not_echo_a_wrong_type_password(client, w, kind):
    r = _create(client, w, kind, password=[SECRET])
    assert r.status_code == 422, r.text
    assert SECRET not in r.text


def test_patch_422_does_not_echo_a_wrong_type_password(client, w):
    token = _link(client, w, "asset")
    r = client.patch(f"/share/{token}", json={"password": {"v": SECRET}}, headers=_auth(w.owner))
    assert r.status_code == 422, r.text
    assert SECRET not in r.text


def test_other_422s_are_unchanged(client, w):
    """Errors that do not involve a password keep FastAPI's default body, input included."""
    from fastapi.encoders import jsonable_encoder
    from pydantic import ValidationError
    from apps.api.schemas.share import ShareLinkCreate

    bad = {"title": "t", "appearance": {"layout": "zigzag"}}
    r = client.post(f"/assets/{w.A.id}/share", json=bad, headers=_auth(w.owner))
    assert r.status_code == 422
    with pytest.raises(ValidationError) as exc:
        ShareLinkCreate.model_validate(bad)
    expected = []
    for e in exc.value.errors(include_url=False):
        e = dict(e)
        e["loc"] = ("body",) + tuple(e["loc"])
        expected.append(e)
    assert r.json() == {"detail": jsonable_encoder(expected)}
    assert r.json()["detail"][0]["input"] == "zigzag"


def test_a_bare_body_422_off_the_verify_route_is_unchanged(client, w):
    r = client.post(f"/assets/{w.A.id}/share", json="not-an-object", headers=_auth(w.owner))
    assert r.status_code == 422
    assert r.json()["detail"][0]["input"] == "not-an-object"


# ── 6. a password is bounded by its UTF-8 size ─────────────────────────────────

def _too_long_bodies():
    return [
        "a" * 129,              # 129 bytes
        "é" * 65,          # 65 characters, 130 bytes
        "\U0001F600" * 33,      # 33 characters, 132 bytes
    ]


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("pw", _too_long_bodies())
def test_create_refuses_a_password_over_128_bytes(client, w, kind, pw):
    r = _create(client, w, kind, password=pw)
    assert r.status_code == 422, r.text
    assert pw not in r.text
    assert "128" in r.text


@pytest.mark.parametrize("kind", KINDS)
def test_create_accepts_a_password_of_exactly_128_bytes(client, w, kind):
    pw = "é" * 64  # 64 characters, 128 bytes
    r = _create(client, w, kind, password=pw)
    assert r.status_code == 201, r.text
    token = r.json()["token"]
    assert client.get(f"/share/{token}/details", headers=_auth(w.owner)).json()["password_value"] == pw


@pytest.mark.parametrize("pw", _too_long_bodies())
def test_patch_refuses_a_password_over_128_bytes(client, w, pw):
    token = _link(client, w, "asset")
    r = client.patch(f"/share/{token}", json={"password": pw}, headers=_auth(w.owner))
    assert r.status_code == 422, r.text
    assert pw not in r.text


def test_patch_still_clears_with_an_empty_string(client, w):
    token = _link(client, w, "asset")
    r = client.patch(f"/share/{token}", json={"password": ""}, headers=_auth(w.owner))
    assert r.status_code == 200, r.text
    assert r.json()["has_password"] is False


def test_verify_still_opens_a_link_whose_older_password_is_longer(client, w, db):
    """Links made before the limit can hold longer passwords. Their guests must
    still get in, so verify is not held to the create limit."""
    from apps.api.models.share import ShareLink
    from apps.api.services.auth_service import bcrypt_password_bytes
    long_pw = "x" * 300
    token = _link(client, w, "asset")
    link = db.query(ShareLink).filter(ShareLink.token == token).one()
    link.password_hash = bcrypt.hashpw(bcrypt_password_bytes(long_pw), bcrypt.gensalt(4)).decode()
    db.flush()
    r = client.post(f"/share/{token}/verify", json={"password": long_pw})
    assert r.status_code == 200, r.text


def test_verify_refuses_an_absurd_password_without_echoing_it(client, w):
    token = _link(client, w, "asset")
    pw = "q" * 5000
    r = client.post(f"/share/{token}/verify", json={"password": pw})
    assert r.status_code == 422, r.text
    assert pw not in r.text


# ── 7. multi-create does not hide an encryption failure ───────────────────────

def test_multi_create_logs_an_encryption_failure_and_still_creates(client, w, caplog):
    import apps.api.routers.share as share_router

    def boom(_):
        raise RuntimeError("no key")
    with patch.object(share_router, "encrypt_password", boom), caplog.at_level(logging.WARNING):
        r = _create(client, w, "multi")
    assert r.status_code == 201, r.text
    assert r.json()["has_password"] is True
    assert any(rec.levelno >= logging.WARNING and "encrypt" in rec.getMessage().lower()
               for rec in caplog.records)
    assert not any(PW in rec.getMessage() for rec in caplog.records)
    # The hash still guards the link.
    token = r.json()["token"]
    assert client.post(f"/share/{token}/verify", json={"password": PW}).status_code == 200


# ── 8. the creator skips the password only while they manage links ─────────────
#
# A link's creator opens it without the password, so the dashboard can preview
# it. That holds only while they are an editor or owner of its project: anyone
# who could not read the password in the settings panel must not get around it.
# Three places apply the rule (GET /share/{token}, POST /verify, and the session
# check every guest route runs), and each is pinned below on its own.

def _creator_view(client, token, w, user):
    """What `user` gets at each place the creator bypass lives, with no session."""
    h = _auth(user)
    page = client.get(f"/share/{token}", headers=h)
    assert page.status_code == 200, page.text
    return {
        "requires_password": page.json()["requires_password"],
        "verify_wrong_password": client.post(
            f"/share/{token}/verify", json={"password": "not-the-password"}, headers=h,
        ).status_code,
        "stream_without_session": client.get(
            f"/share/{token}/stream/{w.A.id}", headers=h,
        ).status_code,
    }


BYPASSED = {"requires_password": False, "verify_wrong_password": 200, "stream_without_session": 200}
REFUSED = {"requires_password": True, "verify_wrong_password": 403, "stream_without_session": 403}


@pytest.mark.parametrize("kind", KINDS)
def test_a_creator_who_still_edits_skips_the_password(client, w, kind):
    token = _create(client, w, kind, user=w.editor).json()["token"]
    assert _creator_view(client, token, w, w.editor) == BYPASSED


@pytest.mark.parametrize("kind", KINDS)
def test_a_removed_creator_needs_the_new_password(client, w, kind):
    token = _create(client, w, kind, user=w.editor).json()["token"]
    assert client.patch(f"/share/{token}", json={"password": PW2}, headers=_auth(w.owner)).status_code == 200
    r = client.delete(f"/projects/{w.project.id}/members/{w.editor.id}", headers=_auth(w.owner))
    assert r.status_code == 204, r.text

    assert _creator_view(client, token, w, w.editor) == REFUSED
    # Like any guest, the right password still opens it.
    r = client.post(f"/share/{token}/verify", json={"password": PW2}, headers=_auth(w.editor))
    assert r.status_code == 200, r.text
    assert _guest_calls(client, token, w, r.json()["share_session"]) == (200, 200)


@pytest.mark.parametrize("role", ["reviewer", "viewer"])
def test_a_creator_demoted_below_editor_needs_the_password(client, w, role):
    token = _create(client, w, "asset", user=w.editor).json()["token"]
    r = client.patch(f"/projects/{w.project.id}/members/{w.editor.id}", json={"role": role},
                     headers=_auth(w.owner))
    assert r.status_code == 200, r.text
    assert _creator_view(client, token, w, w.editor) == REFUSED


def test_an_owner_who_did_not_create_the_link_still_needs_the_password(client, w):
    token = _create(client, w, "asset", user=w.editor).json()["token"]
    assert _creator_view(client, token, w, w.owner) == REFUSED
