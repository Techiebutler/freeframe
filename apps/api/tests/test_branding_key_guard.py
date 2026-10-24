"""Branding logo keys, and the upload abort target, are only what the server issued.

A project's `logo_s3_key` and the five instance logo columns hold storage keys
the client hands back after uploading. Responses sign them (the instance ones on
an unauthenticated GET), replacing an instance logo deletes the old key, and
purging a project deletes its logo. `PUT /projects/{id}/branding` and
`PUT /instance/branding` used to store whatever they were sent, so a column
could name any object in the bucket and all of those then acted on it.

Each is now held to the prefix its own upload step issues
(`branding/<project id>/logo/<name>`, `branding/<slot>/<name>`), at store, sign
and delete, plus a migration that clears stored values of any other shape.

`/upload/abort` is in here too: it aborted whatever key and upload id the body
named, after proving ownership of a version only. It now aborts the version's
own stored upload and refuses a request whose values do not match it.

Everything runs against a real Postgres (`real_db`), through the real app.
Storage calls are recorded rather than made.
"""
import importlib.util
import pathlib
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from sqlalchemy import text

from apps.api.services.owned_keys import (
    is_owned_key, is_project_logo_key, is_instance_logo_key, INSTANCE_LOGO_SLOTS,
)

RAW = "raw/other-project/asset/version/original.mp4"
SLOTS = list(INSTANCE_LOGO_SLOTS.items())  # [(logo_type, column), ...]


def _fake_sign(key, *a, **k):
    return f"https://s3.test/{key}"


@pytest.fixture
def s3(monkeypatch):
    """Record what would be signed, deleted and aborted; nothing reaches storage."""
    from apps.api.services import s3_service
    import apps.api.tasks.cleanup_tasks as ct
    import apps.api.routers.upload as upload_module
    calls = {"signed": [], "deleted": [], "aborted": []}

    def sign(key, *a, **k):
        calls["signed"].append(key)
        return _fake_sign(key)

    monkeypatch.setattr(s3_service, "generate_presigned_get_url", sign)
    monkeypatch.setattr(s3_service, "delete_object", lambda key: calls["deleted"].append(key))
    monkeypatch.setattr(ct, "delete_object", lambda key: calls["deleted"].append(key))
    monkeypatch.setattr(ct, "delete_prefix", lambda key: calls["deleted"].append(key))
    monkeypatch.setattr(upload_module, "abort_multipart_upload",
                        lambda key, upload_id: calls["aborted"].append((key, upload_id)))
    monkeypatch.setattr(upload_module, "head_object_size", lambda key: None)
    monkeypatch.setattr(s3_service, "head_object_size", lambda key: 1024)  # avatar-confirm's 2 MB check
    return calls


@pytest.fixture
def api(real_db, s3, monkeypatch):
    """TestClient on the real app, DB = the rolled-back real_db transaction.

    Rate limits are lifted: with a Redis reachable they would otherwise count
    this module's requests, and every rerun's, against one test client."""
    from fastapi.testclient import TestClient
    from apps.api.main import app
    from apps.api.database import get_db
    from apps.api.middleware.auth import get_current_user, get_optional_user
    from apps.api.middleware import rate_limit
    from apps.api.middleware.global_rate_limit import GlobalRateLimitMiddleware

    monkeypatch.setattr(GlobalRateLimitMiddleware, "_check", lambda self, *a: (True, 0))
    monkeypatch.setattr(rate_limit, "check_rate_limit", lambda *a, **k: (True, 0))

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


def _user(real_db, name, superadmin=False):
    from apps.api.models.user import User, UserStatus
    u = User(email=f"{name}-{uuid.uuid4()}@t.local", name=name, status=UserStatus.active,
             is_superadmin=superadmin)
    real_db.add(u)
    real_db.flush()
    return u


def _project(real_db, owner, deleted_days_ago=None):
    from apps.api.models.project import Project, ProjectType, ProjectMember, ProjectRole
    p = Project(name="p", project_type=ProjectType.personal, created_by=owner.id)
    if deleted_days_ago is not None:
        p.deleted_at = datetime.now(timezone.utc) - timedelta(days=deleted_days_ago)
    real_db.add(p)
    real_db.flush()
    real_db.add(ProjectMember(project_id=p.id, user_id=owner.id, role=ProjectRole.owner))
    real_db.flush()
    return p


def _branding(real_db, project, key):
    from apps.api.models.branding import ProjectBranding
    b = ProjectBranding(project_id=project.id, logo_s3_key=key)
    real_db.add(b)
    real_db.flush()
    return b


def _own_logo(project):
    return f"branding/{project.id}/logo/{uuid.uuid4()}.webp"


# ── the rule itself ──────────────────────────────────────────────────────────

def test_is_owned_key_accepts_exactly_one_plain_segment_under_the_prefix():
    assert is_owned_key("a/b/", "a/b/c")
    assert is_owned_key("a/b/", "a/b/c.webp")
    for bad in [None, "", "a/b/", "a/b/.", "a/b/..", "a/b/c/d", "a/b/..\\c", "a/b", "x/a/b/c",
                "https://x/a/b/c", 123, ["a/b/c"]]:
        assert not is_owned_key("a/b/", bad), bad
    assert not is_owned_key("", "anything")


def test_project_logo_rule():
    me, other = uuid.uuid4(), uuid.uuid4()
    assert is_project_logo_key(me, f"branding/{me}/logo/{uuid.uuid4()}.webp")
    for bad in [RAW, f"branding/{other}/logo/x.webp", f"branding/{me}/watermark/x.png",
                f"branding/{me}/logo/", f"branding/{me}/logo/../../{RAW}", f"branding/{me}/logo/a/b",
                f"branding/{str(me).upper()}/logo/x", "branding/logo-light/x", f"avatars/{me}/x"]:
        assert not is_project_logo_key(me, bad), bad
    assert not is_project_logo_key(None, f"branding/{me}/logo/x")


@pytest.mark.parametrize("slot,column", SLOTS)
def test_instance_logo_rule_is_per_slot(slot, column):
    assert is_instance_logo_key(column, f"branding/{slot}/{uuid.uuid4()}")
    for other_slot, _ in SLOTS:
        if other_slot != slot:
            assert not is_instance_logo_key(column, f"branding/{other_slot}/{uuid.uuid4()}")
    for bad in [RAW, f"branding/{slot}/", f"branding/{slot}/../../{RAW}", f"branding/{slot}/a/b",
                f"branding/{uuid.uuid4()}/logo/x.webp"]:
        assert not is_instance_logo_key(column, bad), bad
    assert not is_instance_logo_key("primary_color", f"branding/{slot}/x")


# ── project branding: store ──────────────────────────────────────────────────

@pytest.mark.parametrize("value", [
    RAW,
    "https://tracker.example/p.gif",
    "branding/{other}/logo/x.webp",
    "branding/{me}/watermark/x.png",
    "branding/{me}/logo/../../" + RAW,
    "branding/{me}/logo/a/b",
    "branding/logo-light/x",
])
def test_put_refuses_a_key_that_is_not_this_projects_logo(api, real_db, s3, value):
    mallory = _user(real_db, "mallory")
    victim = _project(real_db, _user(real_db, "victim"))
    mine = _project(real_db, mallory)
    own = _own_logo(mine)
    _branding(real_db, mine, own)

    resp = api(mallory).put(f"/projects/{mine.id}/branding",
                            json={"logo_s3_key": value.format(me=mine.id, other=victim.id),
                                  "custom_title": "changed"})

    assert resp.status_code == 422, resp.text
    from apps.api.models.branding import ProjectBranding
    row = real_db.query(ProjectBranding).filter_by(project_id=mine.id).one()
    real_db.refresh(row)
    assert row.logo_s3_key == own and row.custom_title is None
    assert s3["signed"] == [] and s3["deleted"] == []


def test_logo_issued_by_the_upload_step_is_accepted_and_signed(api, real_db, s3, monkeypatch):
    from apps.api.services import s3_service

    class _Client:
        def generate_presigned_url(self, op, Params, ExpiresIn):
            return f"https://s3.test/put/{Params['Key']}"

    monkeypatch.setattr(s3_service, "get_s3_client", lambda: _Client())
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    c = api(owner)

    issued = c.post(f"/projects/{project.id}/branding/logo-upload")
    assert issued.status_code == 201, issued.text
    key = issued.json()["key"]
    assert is_project_logo_key(project.id, key)

    put = c.put(f"/projects/{project.id}/branding", json={"logo_s3_key": key})
    got = c.get(f"/projects/{project.id}/branding")

    assert put.status_code == 200, put.text
    for body in (put.json(), got.json()):
        assert body["logo_s3_key"] == key
        assert body["logo_url"] == _fake_sign(key)


@pytest.mark.parametrize("cleared", [None, ""])
def test_put_null_or_empty_clears_the_logo(api, real_db, s3, cleared):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    b = _branding(real_db, project, _own_logo(project))

    resp = api(owner).put(f"/projects/{project.id}/branding", json={"logo_s3_key": cleared})

    assert resp.status_code == 200, resp.text
    real_db.refresh(b)
    assert b.logo_s3_key is None
    assert resp.json()["logo_url"] is None


def test_put_without_the_field_keeps_the_logo(api, real_db, s3):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    own = _own_logo(project)
    b = _branding(real_db, project, own)

    resp = api(owner).put(f"/projects/{project.id}/branding", json={"custom_title": "t"})

    assert resp.status_code == 200
    real_db.refresh(b)
    assert b.logo_s3_key == own and b.custom_title == "t"


# ── project branding: values already stored ──────────────────────────────────

@pytest.mark.parametrize("stored", [RAW, "branding/{other}/logo/x.webp", "branding/{me}/logo/a/b"])
def test_get_does_not_sign_or_echo_a_foreign_stored_value(api, real_db, s3, stored):
    owner = _user(real_db, "owner")
    other = _project(real_db, _user(real_db, "other"))
    project = _project(real_db, owner)
    _branding(real_db, project, stored.format(me=project.id, other=other.id))

    resp = api(owner).get(f"/projects/{project.id}/branding")

    assert resp.status_code == 200
    assert resp.json()["logo_url"] is None and resp.json()["logo_s3_key"] is None
    assert s3["signed"] == []


def test_share_validate_does_not_echo_a_foreign_stored_logo(api, real_db, s3):
    from apps.api.models.asset import Asset, AssetType
    from apps.api.models.share import ShareLink, SharePermission
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    asset = Asset(project_id=project.id, name="a", asset_type=AssetType.image, created_by=owner.id)
    real_db.add(asset); real_db.flush()
    link = ShareLink(token=f"tok-{uuid.uuid4()}", created_by=owner.id, asset_id=asset.id,
                     permission=SharePermission.view)
    real_db.add(link); real_db.flush()
    b = _branding(real_db, project, RAW)

    foreign = api(None).get(f"/share/{link.token}").json()["branding"]
    own = _own_logo(project)
    b.logo_s3_key = own
    real_db.flush()
    owned = api(None).get(f"/share/{link.token}").json()["branding"]

    assert foreign["logo_url"] is None
    # A link the page can load, not the key itself.
    assert owned["logo_url"] == _fake_sign(own)


# ── project purge ────────────────────────────────────────────────────────────

def test_project_purge_does_not_delete_a_foreign_stored_logo(real_db, s3, monkeypatch):
    """Through the retention GC, on a project trashed long enough to be purged."""
    import apps.api.tasks.cleanup_tasks as ct
    from apps.api.config import settings
    from apps.api.models.project import Project
    monkeypatch.setattr(settings, "soft_delete_retention_days", 30)

    planted = _project(real_db, _user(real_db, "mallory"), deleted_days_ago=40)
    _branding(real_db, planted, RAW)
    legit = _project(real_db, _user(real_db, "owner"), deleted_days_ago=40)
    own = _own_logo(legit)
    _branding(real_db, legit, own)

    counts = ct.PurgeCounts()
    ct._purge_soft_deleted(real_db, counts)

    assert real_db.query(Project).filter(Project.id.in_([planted.id, legit.id])).count() == 0
    assert RAW not in s3["deleted"]
    assert own in s3["deleted"]


# ── instance branding ────────────────────────────────────────────────────────

@pytest.fixture
def instance_row(real_db):
    """The single instance branding row, starting empty."""
    from apps.api.models.instance_branding import InstanceBranding
    real_db.query(InstanceBranding).delete()
    row = InstanceBranding(org_name="FreeFrame")
    real_db.add(row)
    real_db.flush()
    return row


@pytest.mark.parametrize("slot,column", SLOTS)
def test_instance_put_refuses_a_foreign_key(api, real_db, s3, instance_row, slot, column):
    admin = _user(real_db, "admin", superadmin=True)
    own = f"branding/{slot}/{uuid.uuid4()}"
    setattr(instance_row, column, own)
    real_db.flush()
    wrong_slot = next(s for s, _ in SLOTS if s != slot)

    for value in [RAW, f"branding/{wrong_slot}/{uuid.uuid4()}", f"branding/{slot}/../../{RAW}"]:
        resp = api(admin).put("/instance/branding", json={column: value, "org_name": "Changed"})
        assert resp.status_code == 422, (value, resp.text)

    real_db.refresh(instance_row)
    assert getattr(instance_row, column) == own and instance_row.org_name == "FreeFrame"
    assert s3["deleted"] == []


@pytest.mark.parametrize("slot,column", SLOTS)
def test_instance_issued_key_is_accepted_and_replaces_the_old_one(api, real_db, s3, instance_row,
                                                                   slot, column, monkeypatch):
    from apps.api.services import s3_service
    monkeypatch.setattr(s3_service, "generate_presigned_put_url",
                        lambda key, content_type=None, expires_in=3600: f"https://s3.test/put/{key}")
    admin = _user(real_db, "admin", superadmin=True)
    old = f"branding/{slot}/{uuid.uuid4()}"
    setattr(instance_row, column, old)
    real_db.flush()
    c = api(admin)

    key = c.post(f"/instance/branding/{slot}-upload").json()["key"]
    put = c.put("/instance/branding", json={column: key})
    public = api(None).get("/instance/branding")

    assert put.status_code == 200, put.text
    url_field = column.replace("_key", "_url")
    path = f"/instance/branding/logo/{slot}?v={key.rsplit('/', 1)[-1]}"
    assert put.json()[url_field] == path
    assert public.json()[url_field] == path
    served = api(None).get(path, follow_redirects=False)
    assert served.status_code == 302 and served.headers["location"] == _fake_sign(key)
    assert s3["deleted"] == [old]


@pytest.mark.parametrize("slot,column", SLOTS)
def test_instance_public_get_does_not_sign_a_foreign_stored_value(api, real_db, s3, instance_row,
                                                                  slot, column):
    setattr(instance_row, column, RAW)
    real_db.flush()

    body = api(None).get("/instance/branding").json()

    assert body[column] is None and body[column.replace("_key", "_url")] is None
    assert s3["signed"] == []


@pytest.mark.parametrize("slot,column", SLOTS)
def test_instance_replace_and_reset_do_not_delete_a_foreign_stored_value(api, real_db, s3,
                                                                         instance_row, slot, column):
    admin = _user(real_db, "admin", superadmin=True)
    setattr(instance_row, column, RAW)
    real_db.flush()

    replaced = api(admin).put("/instance/branding", json={column: f"branding/{slot}/{uuid.uuid4()}"})
    setattr(instance_row, column, RAW)
    real_db.flush()
    cleared = api(admin).put("/instance/branding", json={column: None})
    setattr(instance_row, column, RAW)
    real_db.flush()
    reset = api(admin).delete(f"/instance/branding/logo/{slot}")

    assert (replaced.status_code, cleared.status_code, reset.status_code) == (200, 200, 200)
    assert s3["deleted"] == []
    real_db.refresh(instance_row)
    assert getattr(instance_row, column) is None


def test_instance_reset_still_deletes_an_issued_logo(api, real_db, s3, instance_row):
    admin = _user(real_db, "admin", superadmin=True)
    own = f"branding/favicon/{uuid.uuid4()}"
    instance_row.favicon_key = own
    real_db.flush()

    assert api(admin).delete("/instance/branding/logo/favicon").status_code == 200
    assert s3["deleted"] == [own]


# ── upload abort ─────────────────────────────────────────────────────────────

def _uploading_version(real_db, owner, project, upload_id):
    from apps.api.models.asset import Asset, AssetType, AssetVersion, MediaFile, ProcessingStatus, FileType
    asset = Asset(project_id=project.id, name="a", asset_type=AssetType.video, created_by=owner.id)
    real_db.add(asset); real_db.flush()
    v = AssetVersion(asset_id=asset.id, version_number=1, processing_status=ProcessingStatus.uploading,
                     created_by=owner.id, upload_id=upload_id)
    real_db.add(v); real_db.flush()
    key = f"raw/{project.id}/{asset.id}/{v.id}/original.mp4"
    real_db.add(MediaFile(version_id=v.id, file_type=FileType.video, original_filename="a.mp4",
                          mime_type="video/mp4", file_size_bytes=10, s3_key_raw=key))
    real_db.flush()
    return v, key


@pytest.fixture
def two_uploads(real_db):
    alice, mallory = _user(real_db, "alice"), _user(real_db, "mallory")
    a_version, a_key = _uploading_version(real_db, alice, _project(real_db, alice), "alice-upload")
    m_version, m_key = _uploading_version(real_db, mallory, _project(real_db, mallory), "mallory-upload")
    return {"alice": (alice, a_version, a_key), "mallory": (mallory, m_version, m_key)}


def _abort(client, version, key, upload_id):
    return client.post("/upload/abort", json={
        "s3_key": key, "upload_id": upload_id, "version_id": str(version.id)})


def test_abort_refuses_a_key_that_is_not_the_versions(api, real_db, s3, two_uploads):
    mallory, m_version, _ = two_uploads["mallory"]
    _, a_version, a_key = two_uploads["alice"]

    resp = _abort(api(mallory), m_version, a_key, "alice-upload")

    assert resp.status_code == 404
    assert s3["aborted"] == []
    real_db.refresh(m_version); real_db.refresh(a_version)
    assert m_version.processing_status.value == a_version.processing_status.value == "uploading"


def test_abort_refuses_an_upload_id_that_is_not_the_versions(api, real_db, s3, two_uploads):
    mallory, m_version, m_key = two_uploads["mallory"]

    resp = _abort(api(mallory), m_version, m_key, "alice-upload")

    assert resp.status_code == 403
    assert s3["aborted"] == []
    real_db.refresh(m_version)
    assert m_version.processing_status.value == "uploading"


def test_abort_with_the_versions_own_values_still_works(api, real_db, s3, two_uploads):
    mallory, m_version, m_key = two_uploads["mallory"]

    resp = _abort(api(mallory), m_version, m_key, "mallory-upload")

    assert resp.status_code == 204, resp.text
    assert s3["aborted"] == [(m_key, "mallory-upload")]
    real_db.refresh(m_version)
    assert m_version.processing_status.value == "failed"


def test_abort_of_a_version_from_before_upload_ids_were_stored(api, real_db, s3):
    """NULL upload_id is accepted, as presign-part and complete accept it; the key is still pinned."""
    owner = _user(real_db, "owner")
    v, key = _uploading_version(real_db, owner, _project(real_db, owner), None)

    resp = _abort(api(owner), v, key, "legacy-id")

    assert resp.status_code == 204
    assert s3["aborted"] == [(key, "legacy-id")]


# ── avatar-confirm ordering ──────────────────────────────────────────────────

def test_avatar_confirm_deletes_the_previous_avatar_only_after_the_new_key_is_committed(
        api, real_db, s3, monkeypatch):
    """A delete before the commit would leave a rolled-back row naming a deleted object."""
    from apps.api.services import s3_service
    bob = _user(real_db, "bob")
    old = f"avatars/{bob.id}/{uuid.uuid4()}"
    bob.avatar_url = old
    real_db.flush()
    new = f"avatars/{bob.id}/{uuid.uuid4()}"

    commits = []
    real_commit = real_db.commit

    def counting_commit():
        commits.append(1)
        return real_commit()

    monkeypatch.setattr(real_db, "commit", counting_commit)
    seen = []

    def recorder(key):
        # Straight off the connection: no autoflush, so this is what was written.
        stored = real_db.connection().execute(
            text("SELECT avatar_url FROM users WHERE id = :id"), {"id": bob.id}).scalar()
        seen.append((key, stored, len(commits)))

    monkeypatch.setattr(s3_service, "delete_object", recorder)

    resp = api(bob).post(f"/users/{bob.id}/avatar-confirm", json={"key": new})

    assert resp.status_code == 200, resp.text
    assert seen == [(old, new, 1)]


# ── migration ────────────────────────────────────────────────────────────────

def _load_migration():
    path = (pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions"
            / "d2b7e5f9a1c3_clear_foreign_branding_logo_keys.py")
    spec = importlib.util.spec_from_file_location("clear_foreign_branding_logo_keys", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _cases(prefix, other_prefix):
    """(label, value, keep) for one column whose issued prefix is `prefix`."""
    return [
        ("uuid", f"{prefix}{uuid.uuid4()}", True),
        ("ext", f"{prefix}logo.webp", True),
        ("none", None, True),
        ("raw", RAW, False),
        ("http", "https://tracker.example/p.gif", False),
        ("other", f"{other_prefix}x", False),
        ("dotdot", f"{prefix}../../{RAW}", False),
        ("nested", f"{prefix}a/b", False),
        ("empty_name", prefix, False),
        ("dot", f"{prefix}.", False),
        ("dot2", f"{prefix}..", False),
        ("backslash", f"{prefix}a\\b", False),
        ("prefix_only", prefix.rstrip("/"), False),
    ]


def test_migration_clears_foreign_logo_values_and_keeps_issued_ones(real_db):
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from apps.api.models.branding import ProjectBranding
    from apps.api.models.instance_branding import InstanceBranding

    mod = _load_migration()
    assert mod.down_revision == "c4f1e8a2d6b9"
    assert mod._INSTANCE_SLOTS == {c: s for s, c in INSTANCE_LOGO_SLOTS.items()}

    owner = _user(real_db, "owner")
    other = _project(real_db, owner)
    projects = []
    for i in range(len(_cases("x/", "y/"))):
        p = _project(real_db, owner)
        label, value, keep = _cases(f"branding/{p.id}/logo/", f"branding/{other.id}/logo/")[i]
        projects.append((label, _branding(real_db, p, value), value, keep))
    upper = _project(real_db, owner)
    shouted = f"branding/{str(upper.id).upper()}/logo/x"
    projects.append(("upper", _branding(real_db, upper, shouted), shouted, False))

    real_db.query(InstanceBranding).delete()
    instance = []
    for slot, column in SLOTS:
        wrong = next(s for s, _ in SLOTS if s != slot)
        for label, value, keep in _cases(f"branding/{slot}/", f"branding/{wrong}/"):
            row = InstanceBranding(org_name=f"{column}-{label}")
            setattr(row, column, value)
            real_db.add(row)
            instance.append((column, label, row, value, keep))
    real_db.flush()

    with Operations.context(MigrationContext.configure(real_db.connection())):
        mod.upgrade()
    real_db.expire_all()

    for label, b, value, keep in projects:
        real_db.refresh(b)
        assert b.logo_s3_key == (value if keep else None), label
        assert is_project_logo_key(b.project_id, value) == (keep and value is not None), label
    for column, label, row, value, keep in instance:
        real_db.refresh(row)
        assert getattr(row, column) == (value if keep else None), (column, label)
        assert is_instance_logo_key(column, value) == (keep and value is not None), (column, label)

    with Operations.context(MigrationContext.configure(real_db.connection())):
        mod.downgrade()


def test_there_is_exactly_one_alembic_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory
    root = pathlib.Path(__file__).resolve().parents[1]
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "alembic"))
    assert len(ScriptDirectory.from_config(cfg).get_heads()) == 1
