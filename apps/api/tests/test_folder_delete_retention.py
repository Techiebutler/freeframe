"""Database-level folder trash regressions for #394 and #418."""

import uuid
from datetime import datetime, timezone

import pytest
from fastapi import BackgroundTasks
from sqlalchemy.orm import Session

import apps.api.routers.folders as folders_module
import apps.api.routers.upload as upload_module
import apps.api.tasks.cleanup_tasks as cleanup
from apps.api.models.asset import (
    Asset,
    AssetType,
    AssetVersion,
    FileType,
    MediaFile,
    ProcessingStatus,
)
from apps.api.models.folder import Folder
from apps.api.models.project import Project, ProjectMember, ProjectRole, ProjectType
from apps.api.models.user import User
from apps.api.schemas.upload import AbortUploadRequest


@pytest.fixture
def db():
    """A real session where each endpoint commit is observable.

    Each session transaction is a SAVEPOINT, leaving the outer transaction for
    teardown. Rolling back after a route call discards only work after its last
    commit, so assertions inspect committed database state.
    """
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


def _seed(db, status=ProcessingStatus.ready, asset_deleted_at=None):
    owner = User(email=f"folder-trash-{uuid.uuid4()}@t.local", name="t")
    db.add(owner)
    db.flush()

    project = Project(
        name=f"folder-trash-{uuid.uuid4()}",
        project_type=ProjectType.personal,
        created_by=owner.id,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMember(
            project_id=project.id,
            user_id=owner.id,
            role=ProjectRole.editor,
        )
    )

    folder = Folder(
        project_id=project.id,
        name=f"folder-{uuid.uuid4()}",
        created_by=owner.id,
    )
    db.add(folder)
    db.flush()

    asset = Asset(
        project_id=project.id,
        name=f"asset-{uuid.uuid4()}",
        asset_type=AssetType.video,
        created_by=owner.id,
        folder_id=folder.id,
        deleted_at=asset_deleted_at,
    )
    db.add(asset)
    db.flush()

    version = AssetVersion(
        asset_id=asset.id,
        version_number=1,
        processing_status=status,
        created_by=owner.id,
        upload_id=f"upload-{uuid.uuid4()}",
    )
    db.add(version)
    db.flush()
    s3_key = f"raw/{project.id}/{asset.id}/{version.id}/original.mp4"
    db.add(
        MediaFile(
            version_id=version.id,
            file_type=FileType.video,
            original_filename="clip.mp4",
            mime_type="video/mp4",
            file_size_bytes=1,
            s3_key_raw=s3_key,
        )
    )
    db.commit()
    return owner, project, folder, asset, version, s3_key


def _committed(db, model, row_id):
    db.rollback()
    db.expire_all()
    return db.get(model, row_id)


def _delete_folder(db, folder_id, owner):
    folders_module.delete_folder(folder_id, db=db, current_user=owner)


def _restore_folder(db, folder_id, owner):
    folders_module.restore_folder(folder_id, db=db, current_user=owner)


def test_delete_folder_preserves_an_assets_exact_prior_trash_timestamp(db):
    original_deleted_at = datetime(2024, 1, 2, 3, 4, 5, 678901, tzinfo=timezone.utc)
    owner, _, folder, asset, _, _ = _seed(db, asset_deleted_at=original_deleted_at)

    _delete_folder(db, folder.id, owner)

    assert _committed(db, Asset, asset.id).deleted_at == original_deleted_at


def test_restore_folder_keeps_an_earlier_trashed_child_and_asset_in_trash(db):
    owner, project, parent, _, _, _ = _seed()
    child = Folder(
        project_id=project.id,
        name=f"child-{uuid.uuid4()}",
        created_by=owner.id,
        parent_id=parent.id,
    )
    db.add(child)
    db.flush()
    child_asset = Asset(
        project_id=project.id,
        name=f"child-asset-{uuid.uuid4()}",
        asset_type=AssetType.video,
        created_by=owner.id,
        folder_id=child.id,
    )
    db.add(child_asset)
    db.flush()
    db.add(
        AssetVersion(
            asset_id=child_asset.id,
            version_number=1,
            processing_status=ProcessingStatus.ready,
            created_by=owner.id,
        )
    )
    db.commit()

    _delete_folder(db, child.id, owner)
    child_deleted_at = _committed(db, Folder, child.id).deleted_at
    assert child_deleted_at is not None
    assert _committed(db, Asset, child_asset.id).deleted_at == child_deleted_at

    _delete_folder(db, parent.id, owner)
    _restore_folder(db, parent.id, owner)

    assert _committed(db, Folder, parent.id).deleted_at is None
    assert _committed(db, Folder, child.id).deleted_at == child_deleted_at
    assert _committed(db, Asset, child_asset.id).deleted_at == child_deleted_at


def test_restoring_folder_restores_an_in_flight_upload_with_it(db):
    owner, _, folder, asset, version, _ = _seed(db, status=ProcessingStatus.uploading)

    _delete_folder(db, folder.id, owner)
    assert _committed(db, Asset, asset.id).deleted_at is not None

    _restore_folder(db, folder.id, owner)

    assert _committed(db, Folder, folder.id).deleted_at is None
    assert _committed(db, Asset, asset.id).deleted_at is None
    assert _committed(db, AssetVersion, version.id).deleted_at is None


def test_discarded_upload_stays_out_when_its_folder_is_restored(db, monkeypatch):
    owner, _, folder, asset, version, s3_key = _seed(
        db, status=ProcessingStatus.uploading
    )
    monkeypatch.setattr(upload_module, "abort_multipart_upload", lambda *_: None)
    monkeypatch.setattr(cleanup, "abort_multipart_upload", lambda *_: None)
    monkeypatch.setattr(cleanup, "delete_object", lambda *_: None)
    monkeypatch.setattr(cleanup, "delete_prefix", lambda *_: None)

    _delete_folder(db, folder.id, owner)
    body = AbortUploadRequest(
        s3_key=s3_key,
        upload_id=version.upload_id,
        version_id=version.id,
        discard=True,
    )
    upload_module.abort_upload(body, BackgroundTasks(), db=db, current_user=owner)

    _restore_folder(db, folder.id, owner)

    assert _committed(db, Asset, asset.id).deleted_at is not None
    assert _committed(db, AssetVersion, version.id).deleted_at is not None
