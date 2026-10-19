"""Share links into trashed content resolve as not found, and come back on restore.

Trashing a project only sets `Project.deleted_at`; its folders, assets and share
links are left as they are until the retention purge. Share-link validation used
to look at the link row alone, so every link inside a trashed project (asset,
folder, project and multi-item) kept serving listings, media, comments and guest
comment writes. Trashing a folder blanked its listing only because the folder
delete also trashes everything inside it.

Guarded here, each against a real Postgres through the real app:
  * `validate_share_link` resolves a link only while its project, its asset or
    folder, and every folder above that are live. Anything else is the same 404
    as an unknown token, ahead of the disabled (403) and expired (410) checks;
  * `_is_descendant_of` counts only live folders, so a trashed subfolder is no
    longer "inside" a shared folder;
  * project and multi-item links refuse a folder or an asset under a trashed
    folder;
  * `can_access_asset` grants nothing on a trashed project, and `/me/assets` and
    `/me/folders` leave its contents out;
  * `folder_chain_is_live` is false for a folder that does not exist, and its
    walk up `parent_id` ends on a cycle.

Link rows are never touched on delete, so a restore brings them straight back.
Some states below (a live folder or asset under a trashed folder) are written
directly to the database: no endpoint produces them today, because the folder
delete cascades and restore re-roots, and the tests keep it that way should
either of those change.
"""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import bcrypt
import pytest
from sqlalchemy.orm import Session

NOT_FOUND = (404, {"detail": "Share link not found"})
PASSWORD = "correct horse battery"


@pytest.fixture
def db():
    """A real session where each endpoint commit lands in a SAVEPOINT, so the
    app can commit (delete, restore) and the outer transaction still rolls back."""
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
def client(db, monkeypatch):
    from fastapi.testclient import TestClient
    from apps.api.main import app
    from apps.api.database import get_db
    import apps.api.services.event_service as event_service
    import apps.api.services.downloads as downloads

    monkeypatch.setattr(event_service, "publish_sync", lambda *a, **k: True)
    monkeypatch.setattr(downloads, "head_object_size", lambda key: 1234, raising=False)
    monkeypatch.setattr(downloads, "_top_rung_height", lambda prefix: 1080)
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


def _seed(db):
    """A project with root asset A, folder F holding asset AF and subfolder S
    holding asset AS, and one link of each kind."""
    from apps.api.models.user import User
    from apps.api.models.project import Project, ProjectType, ProjectMember, ProjectRole
    from apps.api.models.folder import Folder
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, MediaFile, FileType, ProcessingStatus,
    )
    from apps.api.models.share import AssetShare, ShareLink, ShareLinkItem, SharePermission

    w = World()

    def user(name):
        u = User(email=f"{name}-{uuid.uuid4().hex[:8]}@t.local", name=name)
        db.add(u); db.flush(); db.refresh(u)
        return u

    w.owner, w.editor, w.viewer = user("owner"), user("editor"), user("viewer")
    w.direct, w.creator = user("direct"), user("creator")
    w.project = Project(name="P", project_type=ProjectType.team, created_by=w.owner.id)
    db.add(w.project); db.flush()
    for u, role in ((w.owner, ProjectRole.owner), (w.editor, ProjectRole.editor),
                    (w.viewer, ProjectRole.viewer)):
        db.add(ProjectMember(project_id=w.project.id, user_id=u.id, role=role))
    w.F = Folder(project_id=w.project.id, name="F", created_by=w.owner.id)
    db.add(w.F); db.flush()
    w.S = Folder(project_id=w.project.id, name="S", parent_id=w.F.id, created_by=w.owner.id)
    db.add(w.S); db.flush()

    def asset(name, folder, created_by):
        a = Asset(project_id=w.project.id, name=name, asset_type=AssetType.video,
                  created_by=created_by.id, folder_id=folder.id if folder else None)
        db.add(a); db.flush()
        v = AssetVersion(asset_id=a.id, version_number=1, processing_status=ProcessingStatus.ready,
                         created_by=created_by.id)
        db.add(v); db.flush()
        db.add(MediaFile(version_id=v.id, file_type=FileType.video, original_filename=f"{name}.mov",
                         mime_type="video/quicktime", file_size_bytes=1000,
                         s3_key_raw=f"raw/{a.id}/{name}.mov",
                         s3_key_processed=f"processed/{a.id}/v1/master.m3u8",
                         s3_key_download=f"processed/{a.id}/v1/download.mp4",
                         s3_key_thumbnail=f"thumbs/{a.id}/v1.jpg", duration_seconds=12.0))
        db.flush()
        w.versions[a.id] = v
        return a

    w.versions = {}

    w.A = asset("A", None, w.owner)
    w.AF = asset("AF", w.F, w.owner)
    w.AS = asset("AS", w.S, w.owner)
    w.A_creator = asset("A-by-nonmember", None, w.creator)
    db.add(AssetShare(asset_id=w.A.id, shared_with_user_id=w.direct.id,
                      permission=SharePermission.comment, shared_by=w.owner.id))

    w.links = {}

    def link(kind, **kw):
        row = ShareLink(token=f"{kind}-{uuid.uuid4().hex}", created_by=w.owner.id, title=kind,
                        permission=SharePermission.comment, allow_download=True, **kw)
        db.add(row); db.flush()
        w.links[kind] = row
        return row

    link("asset", asset_id=w.A.id)
    link("folder", folder_id=w.F.id)
    link("subfolder", folder_id=w.S.id)
    link("asset_in_subfolder", asset_id=w.AS.id)
    link("project", project_id=w.project.id)
    multi = link("multi", project_id=w.project.id)
    db.add(ShareLinkItem(share_link_id=multi.id, asset_id=w.A.id))
    db.add(ShareLinkItem(share_link_id=multi.id, folder_id=w.F.id))
    link("password", asset_id=w.A.id,
         password_hash=bcrypt.hashpw(PASSWORD.encode(), bcrypt.gensalt(4)).decode())
    db.flush()
    return w


def _share_calls(token, asset_id, listing):
    """Every share-token endpoint a link holder can call for one asset in scope."""
    calls = [
        ("GET", f"/share/{token}", None),
        ("POST", f"/share/{token}/verify", {"password": PASSWORD}),
        ("GET", f"/share/{token}/stream/{asset_id}", None),
        ("GET", f"/share/{token}/stream/{asset_id}?download=true", None),
        ("GET", f"/share/{token}/downloads/{asset_id}", None),
        ("GET", f"/share/{token}/thumbnail/{asset_id}", None),
        ("GET", f"/share/{token}/assets/{asset_id}/versions", None),
        ("GET", f"/share/{token}/comments?asset_id={asset_id}", None),
        ("POST", f"/share/{token}/comment",
         {"asset_id": str(asset_id), "body": "hello", "guest_email": "g@t.local", "guest_name": "G"}),
    ]
    if listing:
        calls.append(("GET", f"/share/{token}/assets", None))
    return calls


def _call(client, method, path, body=None, headers=None):
    r = client.request(method, path, json=body, headers=headers or {})
    return r.status_code, r.json()


def _trash_project(client, db, w):
    assert client.delete(f"/projects/{w.project.id}", headers=_auth(w.owner)).status_code == 204
    db.expire_all()


# Each link kind, the asset its content calls use, and whether it has a listing.
KINDS = [
    ("asset", "A", False),
    ("folder", "AF", True),
    ("subfolder", "AS", True),
    ("project", "A", True),
    ("multi", "AF", True),
    ("password", "A", False),
]


# ── project trashed ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("kind,asset_attr,listing", KINDS)
def test_every_share_endpoint_is_not_found_once_the_project_is_trashed(client, db, kind, asset_attr, listing):
    w = _seed(db)
    token = w.links[kind].token
    asset_id = getattr(w, asset_attr).id
    assert client.get(f"/share/{token}").status_code == 200
    if kind != "password":
        assert client.get(f"/share/{token}/stream/{asset_id}").status_code == 200

    _trash_project(client, db, w)

    for method, path, body in _share_calls(token, asset_id, listing):
        assert _call(client, method, path, body) == NOT_FOUND, (method, path)


def test_a_trashed_projects_link_answers_exactly_like_an_unknown_token(client, db):
    """No status or detail tells a trashed target apart from a token that never
    existed, whatever state the link itself is in."""
    w = _seed(db)
    disabled, expired = w.links["folder"], w.links["asset"]
    disabled.is_enabled = False
    expired.expires_at = datetime.now(timezone.utc) - timedelta(hours=1)
    db.flush()
    assert client.get(f"/share/{disabled.token}").status_code == 403
    assert client.get(f"/share/{expired.token}").status_code == 410

    _trash_project(client, db, w)

    unknown = f"no-such-{uuid.uuid4().hex}"
    for token in (unknown, disabled.token, expired.token, w.links["project"].token):
        assert _call(client, "GET", f"/share/{token}") == NOT_FOUND
        assert _call(client, "POST", f"/share/{token}/verify", {"password": PASSWORD}) == NOT_FOUND


def test_no_link_can_be_created_once_the_project_is_trashed(client, db):
    from apps.api.models.share import ShareLink
    w = _seed(db)
    _trash_project(client, db, w)
    before = db.query(ShareLink).count()

    for path, body in ((f"/assets/{w.A.id}/share", {}), (f"/folders/{w.F.id}/share", {}),
                       (f"/projects/{w.project.id}/share", {}),
                       (f"/projects/{w.project.id}/share/multi", {"asset_ids": [str(w.A.id)]})):
        r = client.post(path, json=body, headers=_auth(w.editor))
        assert (r.status_code, r.json()) == (404, {"detail": "Project not found"}), path
    assert db.query(ShareLink).count() == before


def test_a_projects_links_work_again_once_it_is_live_again(client, db):
    """There is no project restore endpoint; this pins that the links are only
    hidden, not revoked, so one can be added without touching share links."""
    w = _seed(db)
    _trash_project(client, db, w)
    assert _call(client, "GET", f"/share/{w.links['project'].token}") == NOT_FOUND

    w.project.deleted_at = None
    db.flush()

    for kind, asset_attr, _ in KINDS:
        if kind == "password":
            continue
        token = w.links[kind].token
        assert client.get(f"/share/{token}").status_code == 200, kind
        assert client.get(f"/share/{token}/stream/{getattr(w, asset_attr).id}").status_code == 200, kind


# ── folder and asset trashed, project live ────────────────────────────────────

def test_a_trashed_folders_link_is_not_found_and_comes_back_on_restore(client, db):
    w = _seed(db)
    token = w.links["folder"].token
    assert client.delete(f"/folders/{w.F.id}", headers=_auth(w.editor)).status_code == 204

    for method, path, body in _share_calls(token, w.AF.id, listing=True):
        assert _call(client, method, path, body) == NOT_FOUND, (method, path)
    assert _call(client, "GET", f"/share/{w.links['subfolder'].token}") == NOT_FOUND

    assert client.post(f"/folders/{w.F.id}/restore", headers=_auth(w.editor)).status_code == 200
    db.expire_all()
    assert client.get(f"/share/{token}").status_code == 200
    assert [a["name"] for a in client.get(f"/share/{token}/assets").json()["assets"]] == ["AF"]
    assert client.get(f"/share/{token}/stream/{w.AF.id}").status_code == 200
    assert client.get(f"/share/{w.links['subfolder'].token}").status_code == 200


def test_a_trashed_assets_link_is_not_found_even_when_disabled_and_comes_back_on_restore(client, db):
    w = _seed(db)
    link = w.links["asset"]
    assert client.delete(f"/assets/{w.A.id}", headers=_auth(w.editor)).status_code == 204
    assert _call(client, "GET", f"/share/{link.token}") == NOT_FOUND

    link.is_enabled = False
    db.flush()
    assert _call(client, "GET", f"/share/{link.token}") == NOT_FOUND
    link.is_enabled = True
    db.flush()

    assert client.post(f"/assets/{w.A.id}/restore", headers=_auth(w.editor)).status_code == 200
    db.expire_all()
    assert client.get(f"/share/{link.token}").status_code == 200
    assert client.get(f"/share/{link.token}/stream/{w.A.id}").status_code == 200


def test_a_trashed_subfolder_is_not_inside_its_shared_parent(client, db):
    w = _seed(db)
    token = w.links["folder"].token
    assert client.get(f"/share/{token}/assets?folder_id={w.S.id}").status_code == 200
    assert client.delete(f"/folders/{w.S.id}", headers=_auth(w.editor)).status_code == 204

    status_code, body = _call(client, "GET", f"/share/{token}/assets?folder_id={w.S.id}")
    assert status_code == 403
    assert body == {"detail": "Folder is not within the shared folder"}


# ── states no endpoint produces today: live content under a trashed folder ────

def _trash_folder_only(db, folder):
    """Trash one folder and nothing under it."""
    folder.deleted_at = datetime.now(timezone.utc)
    db.flush()


def test_a_folder_link_under_a_trashed_folder_is_not_found(client, db):
    w = _seed(db)
    _trash_folder_only(db, w.F)
    assert _call(client, "GET", f"/share/{w.links['subfolder'].token}") == NOT_FOUND
    assert _call(client, "GET", f"/share/{w.links['subfolder'].token}/assets") == NOT_FOUND


def test_an_asset_link_under_a_trashed_folder_is_not_found(client, db):
    w = _seed(db)
    _trash_folder_only(db, w.F)
    token = w.links["asset_in_subfolder"].token
    assert _call(client, "GET", f"/share/{token}") == NOT_FOUND
    assert _call(client, "GET", f"/share/{token}/stream/{w.AS.id}") == NOT_FOUND


def test_a_folder_link_refuses_a_live_asset_in_a_trashed_subfolder(client, db):
    w = _seed(db)
    _trash_folder_only(db, w.S)
    token = w.links["folder"].token
    assert client.get(f"/share/{token}/stream/{w.AS.id}").status_code == 403
    assert client.get(f"/share/{token}/thumbnail/{w.AS.id}").status_code == 403
    assert client.get(f"/share/{token}/assets?folder_id={w.S.id}").status_code == 403


@pytest.mark.parametrize("kind", ["project", "multi"])
def test_project_links_refuse_content_under_a_trashed_folder(client, db, kind):
    w = _seed(db)
    token = w.links[kind].token
    assert client.get(f"/share/{token}/assets?folder_id={w.S.id}").status_code == 200
    assert client.get(f"/share/{token}/stream/{w.AS.id}").status_code == 200

    _trash_folder_only(db, w.F)

    assert _call(client, "GET", f"/share/{token}/assets?folder_id={w.S.id}") == (
        403, {"detail": "Folder is not within the shared project"})
    for path in (f"/stream/{w.AS.id}", f"/thumbnail/{w.AS.id}", f"/downloads/{w.AS.id}"):
        assert _call(client, "GET", f"/share/{token}{path}") == (404, {"detail": "Asset not found"}), path


# ── signed-in access to a trashed project ─────────────────────────────────────

def test_no_signed_in_path_reaches_a_trashed_projects_assets(client, db):
    w = _seed(db)
    who = [(w.viewer, w.A), (w.editor, w.A), (w.direct, w.A), (w.creator, w.A_creator)]
    comment = {"version_id": str(w.versions[w.A.id].id), "body": "a note"}
    reads = ("", "/versions", "/stream", "/downloads", "/comments")
    for user, asset in who:
        for path in reads:
            r = client.get(f"/assets/{asset.id}{path}", headers=_auth(user))
            assert r.status_code == 200, (user.name, path)
    assert client.post(f"/assets/{w.A.id}/comments", json=comment, headers=_auth(w.editor)).status_code == 201

    _trash_project(client, db, w)

    for user, asset in who:
        for path in reads:
            r = client.get(f"/assets/{asset.id}{path}", headers=_auth(user))
            assert r.status_code == 403, (user.name, path)
    for user in (w.editor, w.direct):
        r = client.post(f"/assets/{w.A.id}/comments", json=comment, headers=_auth(user))
        assert r.status_code == 403, user.name


def test_my_assets_and_folders_leave_out_a_trashed_project(client, db):
    w = _seed(db)
    lists = {
        "all": (w.viewer, "/me/assets?limit=100"),
        "owned": (w.creator, "/me/assets?filter=owned"),
        "shared": (w.direct, "/me/assets?filter=shared"),
        "folders": (w.viewer, "/me/folders?limit=50"),
    }
    for name, (user, path) in lists.items():
        assert client.get(path, headers=_auth(user)).json(), name

    _trash_project(client, db, w)

    for name, (user, path) in lists.items():
        r = client.get(path, headers=_auth(user))
        assert r.status_code == 200, name
        assert r.json() == [], name


# ── the folder walk itself ────────────────────────────────────────────────────

def test_folder_chain_is_live_is_false_for_an_unknown_folder(db):
    from apps.api.services.permissions import folder_chain_is_live
    assert folder_chain_is_live(db, uuid.uuid4()) is False


def test_folder_chain_is_live_ends_on_a_parent_cycle(db):
    """No endpoint can make a cycle (moves under a folder's own descendant are
    refused), but the walk must still end if one is ever written: a statement
    timeout turns a walk that never ends into a failure instead of a hang."""
    from sqlalchemy import text
    from apps.api.services.permissions import folder_chain_is_live

    w = _seed(db)
    db.execute(text("SET LOCAL statement_timeout = '3s'"))
    w.F.parent_id = w.S.id
    db.flush()

    assert folder_chain_is_live(db, w.S.id) is True
    _trash_folder_only(db, w.F)
    assert folder_chain_is_live(db, w.S.id) is False
