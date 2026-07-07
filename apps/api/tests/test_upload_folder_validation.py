"""Tests for folder validation on POST /upload/initiate (#65).

Without this validation, a live asset could be created under a soft-deleted
(trashed) or foreign-project folder. The retention GC's `_purge_folder` deletes
assets by `folder_id` with no `deleted_at` filter (it must, to avoid FK
violations when the folder itself is hard-deleted), so an unvalidated
`folder_id` on initiate becomes a data-loss vector: a live asset silently
gets swept up and hard-deleted (S3 objects included) the next time its
trashed folder is purged.
"""
import uuid
from unittest.mock import MagicMock

import apps.api.routers.upload as upload_module


def _valid_body(**overrides):
    body = {
        "project_id": str(uuid.uuid4()),
        "folder_id": str(uuid.uuid4()),
        "mime_type": "image/png",
        "original_filename": "a.png",
        "file_size_bytes": 10,
        "asset_name": "a",
    }
    body.update(overrides)
    return body


def test_initiate_upload_rejects_soft_deleted_or_foreign_folder(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    # Bypass the upstream gates so we isolate the folder-validation path.
    monkeypatch.setattr(upload_module, "upload_guard_error", lambda db, n: None)
    monkeypatch.setattr(upload_module, "require_project_role", lambda db, pid, u, r: None)

    project = MagicMock()
    # Query sequence inside initiate_upload after the gates are bypassed:
    #   1) project lookup -> project (truthy)
    #   2) folder lookup -> None (folder missing / soft-deleted / foreign project)
    mock_db.first.side_effect = [project, None]

    resp = client.post("/upload/initiate", json=_valid_body(), headers=auth_headers)

    assert resp.status_code == 404
    assert resp.json()["detail"] == "Folder not found"


def test_initiate_upload_allows_valid_folder(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    """Sanity check: a real, project-owned, non-deleted folder is accepted."""
    monkeypatch.setattr(upload_module, "upload_guard_error", lambda db, n: None)
    monkeypatch.setattr(upload_module, "require_project_role", lambda db, pid, u, r: None)
    monkeypatch.setattr(
        upload_module, "create_multipart_upload", lambda s3_key, mime_type: "fake-upload-id"
    )

    project = MagicMock()
    folder = MagicMock()

    # Query sequence: project lookup -> project, folder lookup -> folder,
    # then last_version lookup -> None (first version).
    mock_db.first.side_effect = [project, folder, None]

    def _add(obj):
        # Emulate the DB assigning identity/attrs to the asset/version on add+flush.
        if not hasattr(obj, "id") or obj.id is None:
            obj.id = uuid.uuid4()

    mock_db.add.side_effect = _add

    resp = client.post("/upload/initiate", json=_valid_body(), headers=auth_headers)

    assert resp.status_code == 200


def test_initiate_upload_new_version_ignores_bad_folder(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    """Uploading a new VERSION of an existing asset (asset_id given) must NOT
    validate folder_id: that path ignores/does not persist folder_id, so a bogus
    (e.g. now-trashed) folder_id must not cause a spurious 404 -- there is no
    data-loss risk in this branch.
    """
    monkeypatch.setattr(upload_module, "upload_guard_error", lambda db, n: None)
    monkeypatch.setattr(upload_module, "require_project_role", lambda db, pid, u, r: None)
    monkeypatch.setattr(
        upload_module, "create_multipart_upload", lambda s3_key, mime_type: "fake-upload-id"
    )

    project_id = uuid.uuid4()
    asset_id = uuid.uuid4()

    project = MagicMock()
    asset = MagicMock()
    asset.id = asset_id
    asset.project_id = project_id  # must match body.project_id (else 400)
    asset.asset_type = upload_module.AssetType.image

    # Query sequence for the asset_id (new-version) branch:
    #   1) project lookup -> project
    #   2) asset lookup -> asset  (NO folder lookup happens in this branch)
    #   3) last_version lookup -> None (first version for this asset)
    mock_db.first.side_effect = [project, asset, None]

    def _add(obj):
        if not hasattr(obj, "id") or obj.id is None:
            obj.id = uuid.uuid4()

    mock_db.add.side_effect = _add

    body = _valid_body(
        project_id=str(project_id),
        asset_id=str(asset_id),
        folder_id=str(uuid.uuid4()),  # bogus/trashed folder id -- must be ignored
    )
    resp = client.post("/upload/initiate", json=body, headers=auth_headers)

    # The key assertion: NOT rejected for the bad folder.
    assert resp.status_code != 404
    assert resp.status_code == 200
