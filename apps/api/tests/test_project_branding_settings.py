"""Project branding, share-page branding and the small project-settings fixes.

`PUT /projects/{id}/branding` dropped every null it was sent, so a colour,
title, footer or logo could be set but never cleared, and an over-long footer or
title reached Postgres and came back as a 500. Share pages got project branding
only on single-asset links, and the logo there was a storage key, not something
a browser can load. `PATCH /projects/{id}` could not clear a description, and
the member list carried no joined date.

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

RAW = "raw/other-project/asset/version/original.mp4"


def _signed(key):
    return f"https://s3.test/{key}"


@pytest.fixture
def s3(monkeypatch):
    """Record what would be signed and deleted; nothing reaches storage."""
    from apps.api.services import s3_service
    import apps.api.routers.share as share_module
    import apps.api.routers.projects as projects_module
    calls = {"signed": [], "deleted": []}

    def sign(key, *a, **k):
        calls["signed"].append(key)
        return _signed(key)

    monkeypatch.setattr(s3_service, "generate_presigned_get_url", sign)
    monkeypatch.setattr(share_module, "generate_presigned_get_url", sign)
    monkeypatch.setattr(projects_module, "generate_presigned_get_url", sign)
    monkeypatch.setattr(s3_service, "delete_object", lambda key: calls["deleted"].append(key))
    return calls


@pytest.fixture
def api(real_db, s3, monkeypatch):
    """TestClient on the real app, DB = the rolled-back real_db transaction."""
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


def _user(real_db, name):
    from apps.api.models.user import User, UserStatus
    u = User(email=f"{name}-{uuid.uuid4()}@t.local", name=name, status=UserStatus.active)
    real_db.add(u)
    real_db.flush()
    return u


def _project(real_db, owner, poster=None, description=None):
    from apps.api.models.project import Project, ProjectType, ProjectMember, ProjectRole
    p = Project(name="p", project_type=ProjectType.personal, created_by=owner.id,
                description=description)
    real_db.add(p)
    real_db.flush()
    if poster:
        p.poster_s3_key = f"posters/{p.id}/poster.jpg"
    real_db.add(ProjectMember(project_id=p.id, user_id=owner.id, role=ProjectRole.owner))
    real_db.flush()
    return p


def _branding(real_db, project, **fields):
    from apps.api.models.branding import ProjectBranding
    b = ProjectBranding(project_id=project.id, **fields)
    real_db.add(b)
    real_db.flush()
    return b


def _own_logo(project):
    return f"branding/{project.id}/logo/{uuid.uuid4()}.webp"


def _row(real_db, project):
    from apps.api.models.branding import ProjectBranding
    row = real_db.query(ProjectBranding).filter_by(project_id=project.id).one()
    real_db.refresh(row)
    return row


# ── migration ────────────────────────────────────────────────────────────────

def _load_migration():
    path = (pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions"
            / "c5d1f3a7b9e2_add_use_cover_as_logo_to_project_brandings.py")
    spec = importlib.util.spec_from_file_location("add_use_cover_as_logo", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _column(real_db):
    return real_db.execute(text(
        "SELECT is_nullable, column_default FROM information_schema.columns "
        "WHERE table_name = 'project_brandings' AND column_name = 'use_cover_as_logo'"
    )).first()


def test_migration_adds_the_column_off_for_existing_rows_and_downgrade_drops_it(real_db):
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    mod = _load_migration()
    assert mod.down_revision == "e3a7c1d9b5f2"

    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    _branding(real_db, project, custom_footer="kept")

    with Operations.context(MigrationContext.configure(real_db.connection())):
        mod.downgrade()
    assert _column(real_db) is None

    with Operations.context(MigrationContext.configure(real_db.connection())):
        mod.upgrade()
    nullable, default = _column(real_db)
    assert nullable == "NO" and "false" in default
    existing = real_db.execute(text(
        "SELECT use_cover_as_logo, custom_footer FROM project_brandings WHERE project_id = :p"
    ), {"p": project.id}).one()
    assert tuple(existing) == (False, "kept")


def test_a_new_branding_row_does_not_use_the_cover(real_db):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    real_db.execute(text("INSERT INTO project_brandings (id, project_id, viewer_layout) "
                         "VALUES (:i, :p, 'grid')"), {"i": uuid.uuid4(), "p": project.id})
    assert _row(real_db, project).use_cover_as_logo is False


# ── PUT /projects/{id}/branding ──────────────────────────────────────────────

def test_explicit_null_clears_colour_title_and_footer(api, real_db):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    _branding(real_db, project, primary_color="#112233", custom_title="t", custom_footer="f",
              secondary_color="#445566")

    resp = api(owner).put(f"/projects/{project.id}/branding",
                          json={"primary_color": None, "custom_title": None, "custom_footer": None})

    assert resp.status_code == 200, resp.text
    row = _row(real_db, project)
    assert (row.primary_color, row.custom_title, row.custom_footer) == (None, None, None)
    assert row.secondary_color == "#445566"
    body = resp.json()
    assert (body["primary_color"], body["custom_title"], body["custom_footer"]) == (None, None, None)


def test_empty_string_clears_colour_and_footer(api, real_db):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    _branding(real_db, project, primary_color="#112233", custom_footer="f")

    resp = api(owner).put(f"/projects/{project.id}/branding",
                          json={"primary_color": "", "custom_footer": ""})

    assert resp.status_code == 200, resp.text
    row = _row(real_db, project)
    assert (row.primary_color, row.custom_footer) == (None, None)


def test_omitted_fields_are_left_alone(api, real_db):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    _branding(real_db, project, primary_color="#112233", custom_footer="f", use_cover_as_logo=True)

    resp = api(owner).put(f"/projects/{project.id}/branding", json={"custom_title": "new"})

    assert resp.status_code == 200, resp.text
    row = _row(real_db, project)
    assert (row.primary_color, row.custom_footer, row.custom_title) == ("#112233", "f", "new")
    assert row.use_cover_as_logo is True


def test_use_cover_as_logo_is_saved_and_returned(api, real_db):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    c = api(owner)

    assert c.get(f"/projects/{project.id}/branding").json()["use_cover_as_logo"] is False
    on = c.put(f"/projects/{project.id}/branding", json={"use_cover_as_logo": True})
    assert on.status_code == 200, on.text
    assert on.json()["use_cover_as_logo"] is True
    assert c.get(f"/projects/{project.id}/branding").json()["use_cover_as_logo"] is True
    off = c.put(f"/projects/{project.id}/branding", json={"use_cover_as_logo": False})
    assert off.json()["use_cover_as_logo"] is False
    assert _row(real_db, project).use_cover_as_logo is False


@pytest.mark.parametrize("field", ["viewer_layout", "use_cover_as_logo"])
def test_null_never_reaches_a_not_null_column(api, real_db, field):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    _branding(real_db, project, use_cover_as_logo=True)

    resp = api(owner).put(f"/projects/{project.id}/branding", json={field: None, "custom_title": "t"})

    assert resp.status_code == 422, resp.text
    row = _row(real_db, project)
    assert row.viewer_layout.value == "grid" and row.use_cover_as_logo is True
    assert row.custom_title is None


@pytest.mark.parametrize("colour", ["#112233\n", 123, "#12345", "red"])
def test_a_bad_colour_is_a_422_not_a_500(api, real_db, colour):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)

    resp = api(owner).put(f"/projects/{project.id}/branding", json={"primary_color": colour})

    assert resp.status_code == 422, resp.text


@pytest.mark.parametrize("field,limit", [("custom_footer", 500), ("custom_title", 255),
                                         ("featured_field", 255)])
def test_over_long_text_is_a_422_not_a_500(api, real_db, field, limit):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    c = api(owner)

    too_long = c.put(f"/projects/{project.id}/branding", json={field: "x" * (limit + 1)})
    at_limit = c.put(f"/projects/{project.id}/branding", json={field: "x" * limit})

    assert too_long.status_code == 422, too_long.text
    assert at_limit.status_code == 200, at_limit.text
    assert getattr(_row(real_db, project), field) == "x" * limit


def test_replacing_the_logo_deletes_the_old_one_after_the_commit(api, real_db, s3, monkeypatch):
    from apps.api.services import s3_service
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    old = _own_logo(project)
    _branding(real_db, project, logo_s3_key=old)
    new = _own_logo(project)

    commits = []
    real_commit = real_db.commit

    def counting_commit():
        commits.append(1)
        return real_commit()

    monkeypatch.setattr(real_db, "commit", counting_commit)
    seen = []

    def recorder(key):
        stored = real_db.connection().execute(
            text("SELECT logo_s3_key FROM project_brandings WHERE project_id = :p"),
            {"p": project.id}).scalar()
        seen.append((key, stored, len(commits)))

    monkeypatch.setattr(s3_service, "delete_object", recorder)

    resp = api(owner).put(f"/projects/{project.id}/branding", json={"logo_s3_key": new})

    assert resp.status_code == 200, resp.text
    assert seen == [(old, new, 1)]


def test_clearing_the_logo_deletes_it(api, real_db, s3):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    old = _own_logo(project)
    _branding(real_db, project, logo_s3_key=old)

    resp = api(owner).put(f"/projects/{project.id}/branding", json={"logo_s3_key": None})

    assert resp.status_code == 200, resp.text
    assert s3["deleted"] == [old]
    assert _row(real_db, project).logo_s3_key is None


def test_the_logo_is_kept_when_unchanged_or_omitted(api, real_db, s3):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    own = _own_logo(project)
    _branding(real_db, project, logo_s3_key=own)
    c = api(owner)

    same = c.put(f"/projects/{project.id}/branding", json={"logo_s3_key": own})
    omitted = c.put(f"/projects/{project.id}/branding", json={"use_cover_as_logo": True})

    assert (same.status_code, omitted.status_code) == (200, 200)
    assert s3["deleted"] == []
    assert _row(real_db, project).logo_s3_key == own


def test_a_foreign_stored_logo_is_cleared_but_never_deleted(api, real_db, s3):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    _branding(real_db, project, logo_s3_key=RAW)

    resp = api(owner).put(f"/projects/{project.id}/branding", json={"logo_s3_key": None})

    assert resp.status_code == 200, resp.text
    assert s3["deleted"] == []
    assert _row(real_db, project).logo_s3_key is None


def test_a_failed_delete_does_not_fail_the_save(api, real_db, s3, monkeypatch):
    from apps.api.services import s3_service
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    _branding(real_db, project, logo_s3_key=_own_logo(project))

    def boom(key):
        raise RuntimeError("storage down")

    monkeypatch.setattr(s3_service, "delete_object", boom)
    resp = api(owner).put(f"/projects/{project.id}/branding", json={"logo_s3_key": None})

    assert resp.status_code == 200, resp.text
    assert _row(real_db, project).logo_s3_key is None


# ── share validate: project branding on every link type ─────────────────────

def _share_links(real_db, owner, project):
    """One public link of each type into `project`, keyed by type."""
    from apps.api.models.asset import Asset, AssetType
    from apps.api.models.folder import Folder
    from apps.api.models.share import ShareLink, ShareLinkItem, SharePermission
    folder = Folder(project_id=project.id, name="f", created_by=owner.id)
    real_db.add(folder); real_db.flush()
    asset = Asset(project_id=project.id, name="a", asset_type=AssetType.image, created_by=owner.id,
                  folder_id=folder.id)
    real_db.add(asset); real_db.flush()

    def link(**target):
        row = ShareLink(token=f"tok-{uuid.uuid4()}", created_by=owner.id,
                        permission=SharePermission.view, **target)
        real_db.add(row); real_db.flush()
        return row

    links = {
        "asset": link(asset_id=asset.id),
        "folder": link(folder_id=folder.id),
        "project": link(project_id=project.id),
        "multi": link(project_id=project.id),
    }
    real_db.add(ShareLinkItem(share_link_id=links["multi"].id, asset_id=asset.id))
    real_db.add(ShareLinkItem(share_link_id=links["multi"].id, folder_id=folder.id))
    real_db.flush()
    return links


LINK_TYPES = ["asset", "folder", "project", "multi"]


@pytest.mark.parametrize("kind", LINK_TYPES)
def test_every_link_type_gets_colour_footer_and_a_signed_logo(api, real_db, s3, kind):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    logo = _own_logo(project)
    _branding(real_db, project, logo_s3_key=logo, primary_color="#AA5500", custom_footer="(c) Studio",
              custom_title="internal")
    token = _share_links(real_db, owner, project)[kind].token

    resp = api(None).get(f"/share/{token}")

    assert resp.status_code == 200, resp.text
    assert resp.json()["branding"] == {
        "logo_url": _signed(logo), "primary_color": "#AA5500", "custom_footer": "(c) Studio",
    }


@pytest.mark.parametrize("kind", LINK_TYPES)
def test_the_cover_is_the_logo_when_the_project_opts_in(api, real_db, s3, kind):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner, poster=True)
    _branding(real_db, project, logo_s3_key=_own_logo(project), use_cover_as_logo=True)
    token = _share_links(real_db, owner, project)[kind].token

    branding = api(None).get(f"/share/{token}").json()["branding"]

    assert branding["logo_url"] == _signed(project.poster_s3_key)


def test_the_cover_is_not_used_unless_the_project_opts_in(api, real_db, s3):
    owner = _user(real_db, "owner")
    with_logo = _project(real_db, owner, poster=True)
    logo = _own_logo(with_logo)
    _branding(real_db, with_logo, logo_s3_key=logo)
    without_logo = _project(real_db, owner, poster=True)
    _branding(real_db, without_logo)

    a = api(None).get(f"/share/{_share_links(real_db, owner, with_logo)['folder'].token}").json()
    b = api(None).get(f"/share/{_share_links(real_db, owner, without_logo)['folder'].token}").json()

    assert a["branding"]["logo_url"] == _signed(logo)
    assert b["branding"]["logo_url"] is None
    assert with_logo.poster_s3_key not in s3["signed"]
    assert without_logo.poster_s3_key not in s3["signed"]


def test_opting_in_without_a_cover_falls_back_to_the_logo(api, real_db, s3):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    logo = _own_logo(project)
    _branding(real_db, project, logo_s3_key=logo, use_cover_as_logo=True)

    branding = api(None).get(f"/share/{_share_links(real_db, owner, project)['project'].token}").json()["branding"]

    assert branding["logo_url"] == _signed(logo)


@pytest.mark.parametrize("kind", LINK_TYPES)
def test_no_branding_row_answers_all_null(api, real_db, s3, kind):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner, poster=True)
    token = _share_links(real_db, owner, project)[kind].token

    branding = api(None).get(f"/share/{token}").json()["branding"]

    assert branding == {"logo_url": None, "primary_color": None, "custom_footer": None}


@pytest.mark.parametrize("kind", LINK_TYPES)
def test_a_foreign_stored_logo_is_never_signed_or_echoed(api, real_db, s3, kind):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    _branding(real_db, project, logo_s3_key=RAW)
    token = _share_links(real_db, owner, project)[kind].token

    body = api(None).get(f"/share/{token}").json()

    assert body["branding"]["logo_url"] is None
    assert RAW not in s3["signed"] and RAW not in str(body)


def test_a_password_gate_sends_no_branding(api, real_db, s3):
    import bcrypt
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    _branding(real_db, project, logo_s3_key=_own_logo(project), custom_footer="f")
    link = _share_links(real_db, owner, project)["folder"]
    link.password_hash = bcrypt.hashpw(b"pw", bcrypt.gensalt()).decode()
    real_db.flush()

    body = api(None).get(f"/share/{link.token}").json()

    assert body["requires_password"] is True and body["branding"] is None


# ── PATCH /projects/{id} ─────────────────────────────────────────────────────

@pytest.mark.parametrize("cleared", [None, ""])
def test_description_can_be_cleared(api, real_db, s3, cleared):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner, description="old words")

    resp = api(owner).patch(f"/projects/{project.id}", json={"description": cleared})

    assert resp.status_code == 200, resp.text
    real_db.refresh(project)
    assert project.description is None and resp.json()["description"] is None


def test_omitting_the_description_keeps_it(api, real_db, s3):
    owner = _user(real_db, "owner")
    project = _project(real_db, owner, description="old words")

    resp = api(owner).patch(f"/projects/{project.id}", json={"name": "renamed", "is_public": None})

    assert resp.status_code == 200, resp.text
    real_db.refresh(project)
    assert (project.name, project.description, project.is_public) == ("renamed", "old words", False)


# ── project members ──────────────────────────────────────────────────────────

def test_members_carry_their_joined_date(api, real_db, s3):
    from apps.api.models.project import ProjectMember
    owner = _user(real_db, "owner")
    project = _project(real_db, owner)
    member = real_db.query(ProjectMember).filter_by(project_id=project.id, user_id=owner.id).one()
    real_db.refresh(member)

    listed = api(owner).get(f"/projects/{project.id}/members")

    assert listed.status_code == 200, listed.text
    (row,) = listed.json()
    assert datetime.fromisoformat(row["invited_at"]) == member.invited_at


def test_re_adding_a_removed_member_restarts_the_joined_date(api, real_db, s3):
    from apps.api.models.project import ProjectMember, ProjectRole
    owner = _user(real_db, "owner")
    bob = _user(real_db, "bob")
    project = _project(real_db, owner)
    long_ago = datetime.now(timezone.utc) - timedelta(days=400)
    old = ProjectMember(project_id=project.id, user_id=bob.id, role=ProjectRole.viewer,
                        invited_at=long_ago, deleted_at=long_ago + timedelta(days=1))
    real_db.add(old); real_db.flush()

    with patch("apps.api.routers.projects.send_task_safe"):
        added = api(owner).post(f"/projects/{project.id}/members",
                                json={"user_id": str(bob.id), "role": "editor"})

    assert added.status_code == 201, added.text
    real_db.refresh(old)
    assert old.deleted_at is None and old.invited_by == owner.id
    assert old.invited_at > long_ago + timedelta(days=1)
    assert datetime.fromisoformat(added.json()["invited_at"]) == old.invited_at
