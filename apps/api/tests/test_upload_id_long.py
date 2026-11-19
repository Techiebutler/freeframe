"""Cloudflare R2's multipart upload ids do not fit in 255 characters (#637).

Every release since v1.9.0 stored `asset_versions.upload_id` as varchar(255).
R2 answers CreateMultipartUpload with a 343-character id, so both initiate
routes failed on the commit that records it, and because the multipart upload
had already been created, each failed attempt left one behind in the bucket.

These run against a real Postgres: the mock session the other upload tests use
accepts a string of any length and cannot see the column's width.
"""
import importlib.util
import pathlib
import string
from types import SimpleNamespace

import pytest
import sqlalchemy as sa
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

import apps.api.routers.assets as assets_module
import apps.api.routers.upload as upload_module
from apps.api.models.asset import AssetVersion


# What R2 hands back: 343 characters of URL-safe base64. A fixed value rather
# than a random one, so a failure names the same id every run.
_R2_ALPHABET = string.ascii_letters + string.digits + "-_"
R2_UPLOAD_ID = (_R2_ALPHABET * 6)[:343]
FILE_SIZE = 1024
ROUTES = ["new_asset", "new_version"]


def test_the_fixture_id_is_shaped_like_r2s():
    assert len(R2_UPLOAD_ID) == 343
    assert set(R2_UPLOAD_ID) <= set(_R2_ALPHABET)
    assert {"-", "_"} <= set(R2_UPLOAD_ID)


@pytest.fixture
def storage(monkeypatch):
    """Stand in for every object-store call the upload routes make, recording
    the upload id each one is handed."""
    calls = SimpleNamespace(
        created=[], presigned=[], listed=[], completed=[], aborted=[],
        parts=[], head_size=None,
    )

    def _create(key, mime):
        calls.created.append(key)
        return R2_UPLOAD_ID

    def _presign(key, upload_id, part):
        calls.presigned.append((key, upload_id))
        return "https://storage.example/part"

    def _list(key, upload_id):
        calls.listed.append((key, upload_id))
        return list(calls.parts)

    for mod in (upload_module, assets_module):
        monkeypatch.setattr(mod, "create_multipart_upload", _create)
    monkeypatch.setattr(upload_module, "presign_upload_part", _presign)
    monkeypatch.setattr(upload_module, "list_upload_parts", _list)
    monkeypatch.setattr(
        upload_module, "complete_multipart_upload",
        lambda key, upload_id, parts: calls.completed.append((key, upload_id)),
    )
    monkeypatch.setattr(
        upload_module, "abort_multipart_upload",
        lambda key, upload_id: calls.aborted.append((key, upload_id)),
    )
    monkeypatch.setattr(upload_module, "head_object_size", lambda key: calls.head_size)
    monkeypatch.setattr(upload_module, "_trigger_processing", lambda *a: None)
    return calls


@pytest.fixture
def owner(seed):
    return seed.user(name="Uploader")


@pytest.fixture
def project(seed, owner):
    return seed.project(owner)


def _body(project):
    return {
        "project_id": str(project.id),
        "asset_name": "clip",
        "original_filename": "clip.mp4",
        "mime_type": "video/mp4",
        "file_size_bytes": FILE_SIZE,
    }


def _initiate(client, seed, owner, project, path):
    if path == "new_asset":
        return client.post("/upload/initiate", json=_body(project))
    asset = seed.asset(project, owner)
    return client.post(f"/assets/{asset.id}/versions", json=_body(project))


def _stored_length(db, version_id):
    """Read from the column itself, not from the identity map, which would hand
    back the string the route assigned whatever the database kept."""
    return db.execute(
        text("SELECT length(upload_id) FROM asset_versions WHERE id = :id"),
        {"id": version_id},
    ).scalar()


# -- (a), (b) both initiate routes take a 343-character id --------------------

@pytest.mark.parametrize("path", ROUTES)
def test_initiate_stores_and_returns_the_whole_r2_upload_id(
    as_user, live_db, seed, owner, project, storage, path
):
    resp = _initiate(as_user(owner), seed, owner, project, path)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["upload_id"] == R2_UPLOAD_ID
    assert _stored_length(live_db, body["version_id"]) == 343
    assert storage.aborted == []


# -- (c) every route that follows works with that id --------------------------

def test_the_whole_upload_lifecycle_carries_the_r2_upload_id(
    as_user, live_db, seed, owner, project, storage
):
    client = as_user(owner)
    started = client.post("/upload/initiate", json=_body(project)).json()
    key, version_id = started["s3_key"], started["version_id"]
    assert started["upload_id"] == R2_UPLOAD_ID

    presigned = client.post(
        "/upload/presign-part",
        json={"s3_key": key, "upload_id": R2_UPLOAD_ID, "part_number": 1},
    )
    assert presigned.status_code == 200, presigned.text

    resumed = client.get(f"/upload/{version_id}/parts")
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["state"] == "resumable"
    assert resumed.json()["upload_id"] == R2_UPLOAD_ID

    storage.parts = [{"PartNumber": 1, "ETag": '"etag-1"', "Size": FILE_SIZE}]
    storage.head_size = FILE_SIZE
    completed = client.post("/upload/complete", json={
        "s3_key": key, "upload_id": R2_UPLOAD_ID,
        "asset_id": started["asset_id"], "version_id": version_id,
    })
    assert completed.status_code == 200, completed.text
    assert completed.json()["status"] == "processing"

    # Abort a second, fresh upload: the first one is completed.
    storage.head_size = None
    fresh = client.post("/upload/initiate", json=_body(project)).json()
    aborted = client.post("/upload/abort", json={
        "s3_key": fresh["s3_key"], "upload_id": R2_UPLOAD_ID,
        "version_id": fresh["version_id"],
    })
    assert aborted.status_code == 204, aborted.text

    assert storage.presigned == [(key, R2_UPLOAD_ID)]
    # Resume lists once, complete lists once.
    assert storage.listed == [(key, R2_UPLOAD_ID), (key, R2_UPLOAD_ID)]
    assert storage.completed == [(key, R2_UPLOAD_ID)]
    assert storage.aborted == [(fresh["s3_key"], R2_UPLOAD_ID)]


# -- (d) a failed initiate does not leave its multipart upload behind ---------

@pytest.mark.parametrize("path", ROUTES)
def test_initiate_aborts_the_upload_it_started_when_the_commit_fails(
    as_user, live_db, seed, owner, project, storage, monkeypatch, path
):
    client = as_user(owner)
    if path == "new_version":
        asset = seed.asset(project, owner)

    def _refuse():
        raise OperationalError("COMMIT", {}, Exception("server closed the connection"))

    # The route's rollback would otherwise end the fixture's own transaction, and
    # its teardown would then roll back one that is no longer there. Fence the
    # request in a savepoint and have the session's rollback end only that: what
    # the route wrote is still really discarded.
    savepoint = live_db.begin_nested()
    monkeypatch.setattr(
        live_db, "rollback", lambda: savepoint.rollback() if savepoint.is_active else None,
    )
    monkeypatch.setattr(live_db, "commit", _refuse)
    if path == "new_asset":
        resp = client.post("/upload/initiate", json=_body(project))
    else:
        resp = client.post(f"/assets/{asset.id}/versions", json=_body(project))

    assert resp.status_code == 500
    assert len(storage.created) == 1
    assert storage.aborted == [(storage.created[0], R2_UPLOAD_ID)]
    assert not savepoint.is_active  # the route did roll back


def test_the_original_commit_error_survives_an_abort_that_fails_too(caplog):
    """The abort is best-effort: its own failure is logged, and what the caller
    sees is still the reason the version could not be saved."""
    calls = []

    class _Session:
        def commit(self):
            raise OperationalError("COMMIT", {}, Exception("server closed the connection"))

        def rollback(self):
            calls.append("rollback")

    def _abort(key, upload_id):
        calls.append(("abort", key, upload_id))
        raise RuntimeError("storage is down too")

    original = upload_module.abort_multipart_upload
    upload_module.abort_multipart_upload = _abort
    try:
        with pytest.raises(OperationalError):
            upload_module.commit_initiated_upload(_Session(), "raw/p/a/v/original.mp4", R2_UPLOAD_ID)
    finally:
        upload_module.abort_multipart_upload = original

    # Rollback first: the failed transaction and its locks must not wait on storage.
    assert calls == ["rollback", ("abort", "raw/p/a/v/original.mp4", R2_UPLOAD_ID)]
    assert "could not abort" in caplog.text
    assert "storage is down too" in caplog.text


def test_the_original_commit_error_survives_a_rollback_that_fails_too(monkeypatch, caplog):
    """A dead connection fails the rollback as well. That is logged, the upload
    is still aborted, and the caller still gets the commit's error."""
    aborted = []

    class _Session:
        def commit(self):
            raise OperationalError("COMMIT", {}, Exception("server closed the connection"))

        def rollback(self):
            raise RuntimeError("connection is dead")

    monkeypatch.setattr(
        upload_module, "abort_multipart_upload",
        lambda key, upload_id: aborted.append((key, upload_id)),
    )
    with pytest.raises(OperationalError, match="server closed the connection"):
        upload_module.commit_initiated_upload(_Session(), "raw/p/a/v/original.mp4", R2_UPLOAD_ID)

    assert aborted == [("raw/p/a/v/original.mp4", R2_UPLOAD_ID)]
    assert "could not roll back" in caplog.text
    assert "connection is dead" in caplog.text


# -- (e) the model ------------------------------------------------------------

def test_the_model_declares_upload_id_as_unbounded_text():
    column = AssetVersion.__table__.c.upload_id
    assert isinstance(column.type, sa.Text)
    assert column.type.length is None
    assert column.nullable


# -- (f) the migration --------------------------------------------------------

def _load_migration():
    path = (pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions"
            / "a6c3e9d1f472_widen_asset_versions_upload_id.py")
    spec = importlib.util.spec_from_file_location("widen_asset_versions_upload_id", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _column_shape(db):
    return db.execute(text(
        "SELECT data_type, character_maximum_length FROM information_schema.columns "
        "WHERE table_name = 'asset_versions' AND column_name = 'upload_id'"
    )).one()


def _stored_id(db, version_id):
    return db.execute(
        text("SELECT upload_id FROM asset_versions WHERE id = :id"), {"id": version_id},
    ).scalar()


def test_migration_widens_and_its_downgrade_clears_ids_that_no_longer_fit(real_db):
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from apps.api.tests.conftest import MediaSeed

    mod = _load_migration()
    assert mod.down_revision == "7c3a9d4b1e2f"

    rows = MediaSeed(real_db)
    person = rows.user()
    asset = rows.asset(rows.project(person), person)
    long_version, _ = rows.version(asset, person, number=1)
    short_version, _ = rows.version(asset, person, number=2)
    long_version.upload_id = R2_UPLOAD_ID
    short_version.upload_id = "minio-style-upload-id"
    real_db.flush()

    with Operations.context(MigrationContext.configure(real_db.connection())):
        mod.downgrade()

    assert tuple(_column_shape(real_db)) == ("character varying", 255)
    # Never truncated: a shortened id names a different upload, or none.
    assert _stored_id(real_db, long_version.id) is None
    assert _stored_id(real_db, short_version.id) == "minio-style-upload-id"

    with Operations.context(MigrationContext.configure(real_db.connection())):
        mod.upgrade()

    assert tuple(_column_shape(real_db)) == ("text", None)
    assert _stored_id(real_db, short_version.id) == "minio-style-upload-id"
