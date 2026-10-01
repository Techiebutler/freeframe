"""Folder deletion must not restart retention for rows already in the trash (#418)."""

import uuid

import apps.api.routers.folders as folders_module
from apps.api.models.asset import Asset
from apps.api.models.folder import Folder


def test_delete_folder_only_updates_rows_not_already_deleted(
    mock_db, test_user, monkeypatch
):
    folder_id = uuid.uuid4()
    descendant_id = uuid.uuid4()
    folder = type("FolderStub", (), {"project_id": uuid.uuid4()})()
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
