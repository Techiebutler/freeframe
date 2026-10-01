"""Folder trash operations preserve independently deleted and unusable rows (#394, #418)."""

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from sqlalchemy.dialects import postgresql

import apps.api.routers.folders as folders_module
from apps.api.models.asset import Asset, AssetVersion
from apps.api.models.folder import Folder
from apps.api.models.project import Project


def test_delete_folder_only_updates_rows_not_already_deleted(
    mock_db, test_user, monkeypatch
):
    folder_id = uuid.uuid4()
    descendant_id = uuid.uuid4()
    folder = SimpleNamespace(project_id=uuid.uuid4())
    monkeypatch.setattr(folders_module, "_get_folder", lambda db, _id: folder)
    monkeypatch.setattr(
        folders_module, "_get_descendant_ids", lambda db, _id: [descendant_id]
    )
    monkeypatch.setattr(folders_module, "require_project_role", lambda *args: None)

    folders_module.delete_folder(folder_id, db=mock_db, current_user=test_user)

    assert [call.args[0] for call in mock_db.query.call_args_list] == [Folder, Asset]
    folder_filters, asset_filters = [
        call.args for call in mock_db.filter.call_args_list
    ]
    assert "folders.deleted_at IS NULL" in [
        str(predicate) for predicate in folder_filters
    ]
    assert "assets.deleted_at IS NULL" in [
        str(predicate) for predicate in asset_filters
    ]
    assert mock_db.update.call_count == 2
    folder_update, asset_update = [
        call.args[0] for call in mock_db.update.call_args_list
    ]
    assert folder_update["deleted_at"] is asset_update["deleted_at"]
    mock_db.commit.assert_called_once()


def test_restore_folder_only_restores_its_live_cascade(mock_db, test_user, monkeypatch):
    folder_id = uuid.uuid4()
    descendant_id = uuid.uuid4()
    deleted_at = datetime.now(timezone.utc)
    folder = SimpleNamespace(
        project_id=uuid.uuid4(), parent_id=None, deleted_at=deleted_at
    )
    project = SimpleNamespace(deleted_at=None)
    mock_db.first.side_effect = [folder, project]
    monkeypatch.setattr(folders_module, "require_project_role", lambda *args: None)
    monkeypatch.setattr(
        folders_module,
        "_get_descendant_ids_including_deleted",
        lambda db, _id: [descendant_id],
    )

    folders_module.restore_folder(folder_id, db=mock_db, current_user=test_user)

    assert [call.args[0] for call in mock_db.query.call_args_list] == [
        Folder,
        Project,
        Folder,
        Asset,
    ]
    folder_filters, asset_filters = [
        call.args for call in mock_db.filter.call_args_list[-2:]
    ]
    assert any(
        str(predicate).startswith("folders.deleted_at = ")
        for predicate in folder_filters
    )
    assert any(
        str(predicate).startswith("assets.deleted_at = ") for predicate in asset_filters
    )
    eligibility = next(
        predicate for predicate in asset_filters if " OR " in str(predicate)
    )
    eligibility_sql = str(eligibility.compile(dialect=postgresql.dialect()))
    assert f"{AssetVersion.__tablename__}.deleted_at IS NULL" in eligibility_sql
    assert "processing_status IN" in eligibility_sql
    assert folder.deleted_at is None
    mock_db.commit.assert_called_once()


def test_live_upload_version_is_a_valid_restore_reason():
    predicate = folders_module._can_restore_folder_asset()
    sql = str(predicate.compile(dialect=postgresql.dialect()))

    assert " OR " in sql
    assert f"{AssetVersion.__tablename__}.deleted_at IS NULL" in sql
    assert "processing_status IN" in sql
