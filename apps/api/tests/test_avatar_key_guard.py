"""`users.avatar_url` is only signed, served and deleted when it is the user's own avatar.

The column holds a storage key. Every response that shows a user turns it into
a presigned download link, and confirming a new avatar deletes the previous
key. `PATCH /users/{id}` used to store whatever it was sent, so the column could
name any object in the bucket, and both of those then acted on that object.

Guarded in three places, each tested here against a real Postgres:
  * `PATCH /users/{id}` no longer writes the column at all;
  * the response schemas sign only `avatars/<that user's id>/<name>`;
  * `avatar-confirm` only accepts, and only deletes, keys of that shape.
plus a migration that clears existing values of any other shape.

The HTTP tests go through the real app (TestClient) with `get_db` bound to the
`real_db` transaction, so response_model serialisation is exercised too: the
signer runs as a model validator and must not null an avatar on the way out.
"""
import importlib.util
import pathlib
import uuid
from unittest.mock import patch

import pytest

from apps.api.services.avatar_keys import is_own_avatar_key

RAW = "raw/other-project/asset/version/original.mp4"


def _fake_sign(key, *a, **k):
    return f"https://s3.test/{key}"


@pytest.fixture
def s3(monkeypatch):
    """Record what would be signed and deleted; nothing reaches real storage."""
    from apps.api.services import s3_service
    calls = {"signed": [], "deleted": []}

    def sign(key, *a, **k):
        calls["signed"].append(key)
        return _fake_sign(key)

    monkeypatch.setattr(s3_service, "generate_presigned_get_url", sign)
    monkeypatch.setattr(s3_service, "delete_object", lambda key: calls["deleted"].append(key))
    monkeypatch.setattr(s3_service, "head_object_size", lambda key: 1024)  # avatar-confirm's 2 MB check
    return calls


def _user(real_db, name, avatar_url=None):
    from apps.api.models.user import User, UserStatus
    u = User(email=f"{name}-{uuid.uuid4()}@t.local", name=name, status=UserStatus.active,
             avatar_url=avatar_url)
    real_db.add(u)
    real_db.flush()
    return u


@pytest.fixture
def api(real_db, s3, monkeypatch):
    """TestClient on the real app, DB = the rolled-back real_db transaction.

    `as_user(u)` sets who is signed in (None for an anonymous caller)."""
    from fastapi.testclient import TestClient
    from apps.api.main import app
    from apps.api.database import get_db
    from apps.api.middleware.auth import get_current_user, get_optional_user
    import apps.api.routers.comments as comments_module

    monkeypatch.setattr(comments_module.event_service, "publish_sync", lambda *a, **k: True)
    who = {"user": None}
    app.dependency_overrides[get_db] = lambda: real_db
    app.dependency_overrides[get_current_user] = lambda: who["user"]
    app.dependency_overrides[get_optional_user] = lambda: who["user"]
    with patch("apps.api.services.s3_service.ensure_bucket_exists"):
        client = TestClient(app, raise_server_exceptions=False)

        def as_user(u):
            who["user"] = u
            return client

        yield as_user
    app.dependency_overrides.clear()


# ── the key rule itself ───────────────────────────────────────────────────────

def test_the_rule_accepts_only_one_segment_under_the_users_own_prefix():
    me, other = uuid.uuid4(), uuid.uuid4()
    assert is_own_avatar_key(me, f"avatars/{me}/{uuid.uuid4()}")
    assert is_own_avatar_key(me, f"avatars/{me}/pic.webp")
    for bad in [
        None, "", RAW, "https://tracker.example/p.gif", f"http://x/avatars/{me}/a",
        f"avatars/{other}/a.png", f"avatars/{me}/", f"avatars/{me}/.", f"avatars/{me}/..",
        f"avatars/{me}/../../{RAW}", f"avatars/{me}/a/b", f"avatars/{me}/..\\x",
        f"avatars/{me}", f"x/avatars/{me}/a", f"avatars/{str(me).upper()}/a",
    ]:
        assert not is_own_avatar_key(me, bad), bad
    assert not is_own_avatar_key(None, f"avatars/{me}/a")


# ── PATCH /users/{id} ────────────────────────────────────────────────────────

def test_patch_does_not_write_avatar_url(api, real_db, s3):
    bob = _user(real_db, "bob")
    c = api(bob)

    resp = c.patch(f"/users/{bob.id}", json={"avatar_url": RAW})

    assert resp.status_code == 200
    real_db.refresh(bob)
    assert bob.avatar_url is None
    assert resp.json()["avatar_url"] is None
    assert RAW not in s3["signed"]


def test_patch_with_avatar_url_leaves_an_existing_own_avatar_alone(api, real_db, s3):
    bob = _user(real_db, "bob")
    own = f"avatars/{bob.id}/{uuid.uuid4()}"
    bob.avatar_url = own
    real_db.flush()

    resp = api(bob).patch(f"/users/{bob.id}", json={"name": "Bob B", "avatar_url": RAW})

    assert resp.status_code == 200
    real_db.refresh(bob)
    assert bob.avatar_url == own and bob.name == "Bob B"
    assert resp.json()["avatar_url"] == _fake_sign(own)


# ── point of use: values already stored ───────────────────────────────────────

@pytest.mark.parametrize("stored", [
    RAW,
    "https://tracker.example/p.gif",
    "avatars/{other}/a.png",
    "avatars/{me}/../../" + RAW,
])
def test_auth_me_does_not_sign_or_pass_through_a_foreign_value(api, real_db, s3, stored):
    other = _user(real_db, "other")
    bob = _user(real_db, "bob")
    bob.avatar_url = stored.format(me=bob.id, other=other.id)
    real_db.flush()

    resp = api(bob).get("/auth/me")

    assert resp.status_code == 200
    assert resp.json()["avatar_url"] is None
    assert s3["signed"] == []


def test_auth_me_signs_the_users_own_avatar(api, real_db, s3):
    bob = _user(real_db, "bob")
    own = f"avatars/{bob.id}/{uuid.uuid4()}"
    bob.avatar_url = own
    real_db.flush()

    resp = api(bob).get("/auth/me")

    assert resp.json()["avatar_url"] == _fake_sign(own)
    assert s3["signed"] == [own]


def test_user_lookup_endpoints_do_not_sign_a_foreign_value(api, real_db, s3):
    """Batch lookup and search are what the members dialog and pickers read."""
    alice = _user(real_db, "alice")
    bob = _user(real_db, "bobsearch", avatar_url=RAW)
    c = api(alice)

    by_id = c.get(f"/users?ids={bob.id}").json()
    found = [u for u in c.get("/users/search?q=bobsearch").json() if u["id"] == str(bob.id)]

    assert by_id[0]["avatar_url"] is None
    assert found and found[0]["avatar_url"] is None
    assert RAW not in s3["signed"]


@pytest.fixture
def commented(real_db):
    """Bob's own asset, one comment by Bob, and a public share link to it."""
    from apps.api.models.project import Project, ProjectType, ProjectMember, ProjectRole
    from apps.api.models.asset import Asset, AssetType, AssetVersion, ProcessingStatus
    from apps.api.models.comment import Comment
    from apps.api.models.share import ShareLink, SharePermission

    bob = _user(real_db, "bob")
    project = Project(name="p", project_type=ProjectType.personal, created_by=bob.id)
    real_db.add(project); real_db.flush()
    real_db.add(ProjectMember(project_id=project.id, user_id=bob.id, role=ProjectRole.owner))
    asset = Asset(project_id=project.id, name="a", asset_type=AssetType.video, created_by=bob.id)
    real_db.add(asset); real_db.flush()
    version = AssetVersion(asset_id=asset.id, version_number=1,
                           processing_status=ProcessingStatus.ready, created_by=bob.id)
    real_db.add(version); real_db.flush()
    real_db.add(Comment(asset_id=asset.id, version_id=version.id, author_id=bob.id, body="hi"))
    link = ShareLink(token=f"tok-{uuid.uuid4()}", created_by=bob.id, asset_id=asset.id,
                     permission=SharePermission.comment)
    real_db.add(link); real_db.flush()
    return {"bob": bob, "asset": asset, "link": link}


def _author_avatars(api, seed):
    signed_in = api(seed["bob"]).get(f"/assets/{seed['asset'].id}/comments")
    anonymous = api(None).get(f"/share/{seed['link'].token}/comments")
    assert signed_in.status_code == 200, signed_in.text
    assert anonymous.status_code == 200, anonymous.text
    return signed_in.json()[0]["author"]["avatar_url"], anonymous.json()[0]["author"]["avatar_url"]


@pytest.mark.parametrize("stored", [RAW, "https://tracker.example/p.gif", f"avatars/{uuid.uuid4()}/a.png"])
def test_comment_authors_do_not_carry_a_foreign_value(api, real_db, s3, commented, stored):
    commented["bob"].avatar_url = stored
    real_db.flush()

    assert _author_avatars(api, commented) == (None, None)
    assert s3["signed"] == []


def test_comment_authors_carry_the_authors_own_avatar(api, real_db, s3, commented):
    own = f"avatars/{commented['bob'].id}/{uuid.uuid4()}"
    commented["bob"].avatar_url = own
    real_db.flush()

    assert _author_avatars(api, commented) == (_fake_sign(own), _fake_sign(own))


# ── avatar-confirm ───────────────────────────────────────────────────────────

def test_confirm_does_not_delete_a_foreign_stored_value(api, real_db, s3):
    bob = _user(real_db, "bob", avatar_url=RAW)
    new = f"avatars/{bob.id}/{uuid.uuid4()}"

    resp = api(bob).post(f"/users/{bob.id}/avatar-confirm", json={"key": new})

    assert resp.status_code == 200
    assert s3["deleted"] == []
    real_db.refresh(bob)
    assert bob.avatar_url == new
    assert resp.json()["avatar_url"] == _fake_sign(new)


def test_confirm_replaces_and_deletes_the_previous_own_avatar(api, real_db, s3):
    bob = _user(real_db, "bob")
    old = f"avatars/{bob.id}/{uuid.uuid4()}"
    bob.avatar_url = old
    real_db.flush()
    new = f"avatars/{bob.id}/{uuid.uuid4()}"

    resp = api(bob).post(f"/users/{bob.id}/avatar-confirm", json={"key": new})

    assert resp.status_code == 200
    assert s3["deleted"] == [old]
    real_db.refresh(bob)
    assert bob.avatar_url == new


def test_confirming_the_current_key_again_does_not_delete_it(api, real_db, s3):
    bob = _user(real_db, "bob")
    cur = f"avatars/{bob.id}/{uuid.uuid4()}"
    bob.avatar_url = cur
    real_db.flush()

    resp = api(bob).post(f"/users/{bob.id}/avatar-confirm", json={"key": cur})

    assert resp.status_code == 200
    assert s3["deleted"] == []


@pytest.mark.parametrize("key", [
    RAW,
    "avatars/{other}/x.png",
    "avatars/{me}/../../" + RAW,
    "avatars/{me}/a/b",
    "avatars/{me}/",
    "avatars/{me}/..",
])
def test_confirm_refuses_a_key_that_is_not_the_users_own_avatar(api, real_db, s3, key):
    other = _user(real_db, "other")
    bob = _user(real_db, "bob")
    old = f"avatars/{bob.id}/{uuid.uuid4()}"
    bob.avatar_url = old
    real_db.flush()

    resp = api(bob).post(f"/users/{bob.id}/avatar-confirm",
                         json={"key": key.format(me=bob.id, other=other.id)})

    assert resp.status_code == 400
    assert s3["deleted"] == []
    real_db.refresh(bob)
    assert bob.avatar_url == old


def test_confirm_refuses_a_non_string_key(api, real_db, s3):
    bob = _user(real_db, "bob")
    resp = api(bob).post(f"/users/{bob.id}/avatar-confirm", json={"key": ["avatars/x"]})
    assert resp.status_code == 400


# ── migration ────────────────────────────────────────────────────────────────

def _load_migration():
    path = (pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions"
            / "c4f1e8a2d6b9_clear_foreign_avatar_keys.py")
    spec = importlib.util.spec_from_file_location("clear_foreign_avatar_keys", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_migration_clears_foreign_values_and_keeps_own_avatars(real_db):
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    mod = _load_migration()
    assert mod.down_revision == "a7d2c4e6f810"

    other = _user(real_db, "other")
    seeded = {}

    def seed(label, value_fn, keep):
        u = _user(real_db, label)
        u.avatar_url = value_fn(u) if value_fn else None
        seeded[label] = (u, keep)

    seed("own_uuid", lambda u: f"avatars/{u.id}/{uuid.uuid4()}", True)
    seed("own_ext", lambda u: f"avatars/{u.id}/pic.webp", True)
    seed("none", None, True)
    seed("raw", lambda u: RAW, False)
    seed("http", lambda u: "https://tracker.example/p.gif", False)
    seed("other_users", lambda u: f"avatars/{other.id}/x.png", False)
    seed("dotdot", lambda u: f"avatars/{u.id}/../../{RAW}", False)
    seed("nested", lambda u: f"avatars/{u.id}/a/b", False)
    seed("empty_name", lambda u: f"avatars/{u.id}/", False)
    seed("dot", lambda u: f"avatars/{u.id}/.", False)
    seed("dot2", lambda u: f"avatars/{u.id}/..", False)
    seed("backslash", lambda u: f"avatars/{u.id}/a\\b", False)
    seed("prefix_only", lambda u: f"avatars/{u.id}", False)
    seed("upper", lambda u: f"avatars/{str(u.id).upper()}/a", False)
    before = {label: u.avatar_url for label, (u, _) in seeded.items()}
    real_db.flush()

    with Operations.context(MigrationContext.configure(real_db.connection())):
        mod.upgrade()
    real_db.expire_all()

    for label, (u, keep) in seeded.items():
        real_db.refresh(u)
        expected = before[label] if keep else None
        assert u.avatar_url == expected, label
        # The SQL and the Python rule must agree on every seeded value.
        assert is_own_avatar_key(u.id, before[label]) == (keep and before[label] is not None), label

    # Downgrade is a no-op and must not fail.
    with Operations.context(MigrationContext.configure(real_db.connection())):
        mod.downgrade()

