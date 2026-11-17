"""A version number names one cut for the life of an asset (#419).

Numbering used to be the highest surviving `version_number` plus one. That
held for as long as the rows did, and the retention purge hard-deletes a
soft-deleted version after `SOFT_DELETE_RETENTION_DAYS`: when the purged version
was the highest one, the next upload took its number back. With a version
deletable on its own, "v2" in an exported marker list or a share URL would then
name a different cut a month later.

Numbers now come from `Asset.last_version_number`, a counter the purge never
touches. Guarded here against a real Postgres:
  * a purged highest version keeps its number burned, through both handlers
    that create versions;
  * two uploads racing on one asset get different numbers, on two real
    connections, rather than the second dying on the unique constraint;
  * the migration backfills the counter from every version an asset has ever
    had, soft-deleted ones included.
"""
import importlib.util
import pathlib
import threading
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session as _SASession

import apps.api.routers.assets as assets_module
import apps.api.routers.upload as upload_module
import apps.api.tasks.cleanup_tasks as cleanup
from apps.api.models.asset import Asset, AssetType, AssetVersion, ProcessingStatus
from apps.api.services.versions import next_version_number
from apps.api.tests.test_version_numbering import _call, _seed


def _version_number(db, result) -> int:
    return db.query(AssetVersion).filter(AssetVersion.id == result.version_id).one().version_number


@pytest.mark.parametrize("path", ["initiate_upload", "initiate_new_version"])
def test_a_purged_highest_version_keeps_its_number_burned(real_db, monkeypatch, path):
    """v1, v2; v2 deleted and purged; the next upload is v3, not v2 again."""
    for name in ("delete_object", "delete_prefix", "abort_multipart_upload"):
        monkeypatch.setattr(cleanup, name, lambda *_: None)
    monkeypatch.setattr(cleanup.settings, "soft_delete_retention_days", 30)
    owner, project = _seed(real_db, monkeypatch)
    asset = Asset(project_id=project.id, name="t", asset_type=AssetType.video, created_by=owner.id)
    real_db.add(asset)
    real_db.flush()

    first = _call(path, real_db, owner, project, asset)
    second = _call(path, real_db, owner, project, asset)
    assert (_version_number(real_db, first), _version_number(real_db, second)) == (1, 2)
    v2 = real_db.get(AssetVersion, second.version_id)
    v2.processing_status = ProcessingStatus.ready
    v2.deleted_at = datetime.now(timezone.utc) - timedelta(days=31)
    real_db.flush()

    cleanup._purge_soft_deleted(real_db, cleanup.PurgeCounts())
    real_db.expire_all()
    assert real_db.get(AssetVersion, second.version_id) is None, "the purge did not take v2"

    third = _call(path, real_db, owner, project, asset)
    assert _version_number(real_db, third) == 3, (
        f"{path} handed out v{_version_number(real_db, third)} after v2 was purged; "
        "a number must stay burned once its version is gone"
    )


@pytest.mark.parametrize("path", ["initiate_upload", "initiate_new_version"])
def test_numbers_are_counted_per_asset(real_db, monkeypatch, path):
    """Another asset's higher numbers, soft-deleted ones included, are not this one's."""
    from datetime import datetime, timezone

    owner, project = _seed(real_db, monkeypatch)
    other = Asset(project_id=project.id, name="other", asset_type=AssetType.video,
                  created_by=owner.id, last_version_number=57)
    mine = Asset(project_id=project.id, name="mine", asset_type=AssetType.video, created_by=owner.id)
    real_db.add_all([other, mine])
    real_db.flush()
    for number, deleted in ((40, False), (57, True)):
        real_db.add(AssetVersion(asset_id=other.id, version_number=number, created_by=owner.id,
                                 processing_status=ProcessingStatus.ready,
                                 deleted_at=datetime.now(timezone.utc) if deleted else None))
    real_db.add(AssetVersion(asset_id=mine.id, version_number=1, created_by=owner.id,
                             processing_status=ProcessingStatus.ready))
    real_db.flush()

    created = _call(path, real_db, owner, project, mine)

    assert _version_number(real_db, created) == 2


def test_the_number_is_burned_even_when_every_version_is_gone(real_db, monkeypatch):
    """No row left at all: the counter alone carries the history."""
    owner, project = _seed(real_db, monkeypatch)
    asset = Asset(project_id=project.id, name="t", asset_type=AssetType.video,
                  created_by=owner.id, last_version_number=7)
    real_db.add(asset)
    real_db.flush()

    assert next_version_number(real_db, asset.id) == 8
    assert next_version_number(real_db, asset.id) == 9


@pytest.fixture
def committed_asset():
    """An asset committed on its own connection, so a second connection sees it."""
    from apps.api.database import engine
    from apps.api.models.project import Project
    from apps.api.models.user import User

    with engine.connect() as conn:
        s = _SASession(bind=conn)
        user = User(id=uuid.uuid4(), email=f"counter-{uuid.uuid4().hex[:8]}@example.test",
                    name="Counter", password_hash="x", is_superadmin=False)
        s.add(user)
        s.flush()
        project = Project(id=uuid.uuid4(), name="counter", created_by=user.id)
        s.add(project)
        s.flush()
        asset = Asset(id=uuid.uuid4(), project_id=project.id, name="clip",
                      asset_type=AssetType.video, created_by=user.id, last_version_number=4)
        s.add(asset)
        s.commit()
        ids = {"asset": asset.id, "project": project.id, "user": user.id}

    yield ids

    with engine.connect() as conn:
        s = _SASession(bind=conn)
        s.query(Asset).filter(Asset.id == ids["asset"]).delete()
        s.query(Project).filter(Project.id == ids["project"]).delete()
        s.query(User).filter(User.id == ids["user"]).delete()
        s.commit()


def test_two_uploads_racing_on_one_asset_get_different_numbers(committed_asset):
    """The second taker waits for the first to commit, then takes the next number.

    Under the old max-plus-one both read v4 as the highest and both took 5: the
    second insert died on `uq_asset_versions_asset_version`.
    """
    from apps.api.database import engine

    asset_id = committed_asset["asset"]
    with engine.connect() as conn_a, engine.connect() as conn_b:
        a = _SASession(bind=conn_a)
        b = _SASession(bind=conn_b)
        try:
            taken_a = next_version_number(a, asset_id)

            taken_b = []
            def take():
                taken_b.append(next_version_number(b, asset_id))
                b.commit()
            racer = threading.Thread(target=take)
            racer.start()
            racer.join(timeout=1.0)
            assert racer.is_alive(), "the second taker did not wait for the first to commit"

            a.commit()
            racer.join(timeout=10.0)
            assert not racer.is_alive()
            assert (taken_a, taken_b) == (5, [6])
        finally:
            a.rollback()
            b.rollback()
            a.close()
            b.close()


# ── migration ────────────────────────────────────────────────────────────────

def _load_migration():
    path = (pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions"
            / "74cc6317c7f9_add_last_version_number_to_assets.py")
    spec = importlib.util.spec_from_file_location("add_last_version_number_to_assets", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_migration_backfills_the_counter_from_every_version_ever_had(real_db, monkeypatch):
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    mod = _load_migration()
    assert mod.down_revision == "c7f1a4b2e085"
    owner, project = _seed(real_db, monkeypatch)
    gone = datetime.now(timezone.utc)

    def asset_with(rows):
        a = Asset(project_id=project.id, name="t", asset_type=AssetType.video, created_by=owner.id)
        real_db.add(a)
        real_db.flush()
        for number, deleted in rows:
            real_db.add(AssetVersion(asset_id=a.id, version_number=number, created_by=owner.id,
                                     processing_status=ProcessingStatus.ready,
                                     deleted_at=gone if deleted else None))
        real_db.flush()
        return a.id

    cases = {
        asset_with([(1, False), (2, True), (3, True)]): 3,  # highest two soft-deleted
        asset_with([(1, False), (2, False)]): 2,
        asset_with([(4, True)]): 4,                          # nothing live at all
        asset_with([]): 0,                                   # first upload will be v1
    }

    ops = Operations.context(MigrationContext.configure(real_db.connection()))
    with ops:
        mod.downgrade()
        mod.upgrade()
    real_db.expire_all()

    got = dict(real_db.execute(
        text("SELECT id, last_version_number FROM assets WHERE id = ANY(:ids)"),
        {"ids": list(cases)},
    ).all())
    assert got == cases
