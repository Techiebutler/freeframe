"""A restore that loses the race to the retention purge answers 404 (#115).

The purge locks a soft-deleted root, hard-deletes it and commits. A restore
that read the row just before then has nothing left to update. It used to
fail on the UPDATE that matched no row; now it says the item is gone. The
purge runs here in its own session on the same connection, between the
restore's read and its write, which is the order the race produces.
"""

import uuid
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

import apps.api.routers.folders as folders_module
import apps.api.tasks.cleanup_tasks as cleanup
from apps.api.models.asset import Asset, AssetType, AssetVersion, ProcessingStatus
from apps.api.models.folder import Folder
from apps.api.models.project import Project, ProjectMember, ProjectRole, ProjectType
from apps.api.models.user import User


@pytest.fixture
def conn():
    from apps.api.database import engine

    connection = engine.connect()
    trans = connection.begin()
    try:
        yield connection
    finally:
        trans.rollback()
        connection.close()


@pytest.fixture
def db(conn):
    session = Session(bind=conn, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()


@pytest.fixture(autouse=True)
def _no_s3(monkeypatch):
    for name in ("delete_object", "delete_prefix", "abort_multipart_upload"):
        monkeypatch.setattr(cleanup, name, lambda *_: None)


def _seed(db):
    owner = User(email=f"restore-race-{uuid.uuid4()}@t.local", name="t")
    db.add(owner)
    db.flush()
    project = Project(
        name=f"restore-race-{uuid.uuid4()}",
        project_type=ProjectType.personal,
        created_by=owner.id,
    )
    db.add(project)
    db.flush()
    db.add(ProjectMember(project_id=project.id, user_id=owner.id, role=ProjectRole.editor))
    trashed_at = datetime(2024, 1, 1, tzinfo=timezone.utc)
    folder = Folder(
        project_id=project.id, name="Dailies", created_by=owner.id, deleted_at=trashed_at,
    )
    db.add(folder)
    asset = Asset(
        project_id=project.id,
        name="clip",
        asset_type=AssetType.video,
        created_by=owner.id,
        deleted_at=trashed_at,
    )
    db.add(asset)
    db.flush()
    db.add(
        AssetVersion(
            asset_id=asset.id,
            version_number=1,
            processing_status=ProcessingStatus.ready,
            created_by=owner.id,
            deleted_at=trashed_at,
        )
    )
    db.commit()
    return owner, folder.id, asset.id


def _purge_after_the_restore_reads(monkeypatch, conn, purge, model, row_id):
    """Run the purge of `row_id` once the restore has loaded the row and
    checked the caller's role, and before it writes.

    The purge's SAVEPOINT nests inside the restore's, so the restore's rollback
    brings the row back afterwards. That is a property of sharing one test
    connection, not of the race, so the row is checked gone here instead.
    """
    real = folders_module.require_project_role

    def require_then_purge(*args, **kwargs):
        result = real(*args, **kwargs)
        purger = Session(bind=conn, join_transaction_mode="create_savepoint")
        purge(purger, row_id, cleanup.PurgeCounts())
        purger.commit()
        assert purger.get(model, row_id) is None
        purger.close()
        return result

    monkeypatch.setattr(folders_module, "require_project_role", require_then_purge)


def test_restoring_an_asset_the_purge_just_deleted_answers_404(db, conn, monkeypatch):
    owner, _, asset_id = _seed(db)
    _purge_after_the_restore_reads(monkeypatch, conn, cleanup._purge_asset, Asset, asset_id)

    with pytest.raises(HTTPException) as exc_info:
        folders_module.restore_asset(asset_id, db=db, current_user=owner)

    assert exc_info.value.status_code == 404
    assert exc_info.value.detail == "Deleted asset not found"


def test_restoring_a_folder_the_purge_just_deleted_answers_404(db, conn, monkeypatch):
    owner, folder_id, _ = _seed(db)
    _purge_after_the_restore_reads(monkeypatch, conn, cleanup._purge_folder, Folder, folder_id)

    with pytest.raises(HTTPException) as exc_info:
        folders_module.restore_folder(folder_id, db=db, current_user=owner)

    assert exc_info.value.status_code == 404
    assert exc_info.value.detail == "Deleted folder not found"


def test_restores_with_no_purge_in_the_way_still_succeed(db):
    owner, folder_id, asset_id = _seed(db)

    assert folders_module.restore_asset(asset_id, db=db, current_user=owner) == {"ok": True}
    assert folders_module.restore_folder(folder_id, db=db, current_user=owner) == {"ok": True}

    db.rollback()
    db.expire_all()
    assert db.get(Asset, asset_id).deleted_at is None
    assert db.get(Folder, folder_id).deleted_at is None
