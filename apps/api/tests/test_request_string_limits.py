"""Regression coverage for bounded request text stored in varchar columns."""

import uuid

import pytest
from pydantic import ValidationError

from apps.api.middleware.auth import get_optional_user
from apps.api.routers.setup import CreateSuperAdminRequest
from apps.api.schemas.asset import AssetUpdate
from apps.api.schemas.comment import GuestCommentCreate
from apps.api.schemas.metadata import CollectionCreate, MetadataFieldCreate
from apps.api.schemas.project import ProjectCreate, ProjectUpdate
from apps.api.schemas.share import MultiShareCreate, ShareLinkCreate, ShareLinkUpdate
from apps.api.schemas.upload import InitiateUploadRequest


PROJECT_ID = str(uuid.uuid4())
ASSET_ID = str(uuid.uuid4())
FOLDER_ID = str(uuid.uuid4())


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("post", "/projects", {"name": "x" * 256}),
        ("patch", f"/projects/{PROJECT_ID}", {"name": "x" * 256}),
        ("post", f"/projects/{PROJECT_ID}/collections", {"name": "x" * 256}),
        (
            "post",
            f"/projects/{PROJECT_ID}/metadata-fields",
            {"name": "x" * 256, "field_type": "text"},
        ),
        ("patch", f"/assets/{ASSET_ID}", {"name": "x" * 256}),
        (
            "post",
            "/upload/initiate",
            {
                "project_id": PROJECT_ID,
                "asset_name": "x" * 256,
                "original_filename": "file.mp4",
                "mime_type": "video/mp4",
                "file_size_bytes": 1,
            },
        ),
        (
            "post",
            f"/assets/{ASSET_ID}/versions",
            {
                "project_id": PROJECT_ID,
                "asset_name": "asset",
                "original_filename": "x" * 501,
                "mime_type": "video/mp4",
                "file_size_bytes": 1,
            },
        ),
        ("post", f"/assets/{ASSET_ID}/share", {"title": "x" * 256}),
        ("post", f"/folders/{FOLDER_ID}/share", {"title": "x" * 256}),
        ("post", f"/projects/{PROJECT_ID}/share", {"title": "x" * 256}),
        ("post", f"/projects/{PROJECT_ID}/share/multi", {"title": "x" * 256}),
        ("patch", "/share/token", {"title": "x" * 256}),
        ("post", "/share/token/comment", {"body": "hello", "guest_name": "x" * 256}),
        (
            "post",
            "/share/token/comment",
            {"body": "hello", "guest_email": "x" * 250 + "@example.com"},
        ),
        (
            "post",
            "/upload/initiate",
            {
                "project_id": PROJECT_ID,
                "asset_name": "asset",
                "original_filename": "x" * 501,
                "mime_type": "video/mp4",
                "file_size_bytes": 1,
            },
        ),
    ],
    ids=[
        "project-create-name",
        "project-update-name",
        "collection-name",
        "metadata-field-name",
        "asset-update-name",
        "upload-asset-name",
        "asset-version-original-filename",
        "asset-share-title",
        "folder-share-title",
        "project-share-title",
        "multi-share-title",
        "share-update-title",
        "guest-name",
        "guest-email",
        "upload-original-filename",
    ],
)
def test_overlong_request_fields_return_422(client, auth_headers, test_user, monkeypatch, method, path, payload):
    monkeypatch.setitem(client.app.dependency_overrides, get_optional_user, lambda: test_user)
    response = getattr(client, method)(path, json=payload, headers=auth_headers)

    assert response.status_code == 422, response.text


def test_setup_name_is_bounded_to_the_user_column():
    payload = {
        "email": "person@example.com",
        "name": "x" * 256,
        "password": "Password123!",
    }

    with pytest.raises(ValidationError):
        CreateSuperAdminRequest.model_validate(payload)


@pytest.mark.parametrize(
    ("model", "field", "limit", "payload"),
    [
        (ProjectCreate, "name", 255, {}),
        (ProjectUpdate, "name", 255, {}),
        (AssetUpdate, "name", 255, {}),
        (CollectionCreate, "name", 255, {}),
        (MetadataFieldCreate, "name", 255, {"field_type": "text"}),
        (
            CreateSuperAdminRequest,
            "name",
            255,
            {
                "email": "person@example.com",
                "password": "Password123!",
            },
        ),
        (GuestCommentCreate, "guest_name", 255, {"body": "hello"}),
        (GuestCommentCreate, "guest_email", 255, {"body": "hello"}),
        (
            InitiateUploadRequest,
            "asset_name",
            255,
            {
                "project_id": PROJECT_ID,
                "original_filename": "file.mp4",
                "mime_type": "video/mp4",
                "file_size_bytes": 1,
            },
        ),
        (
            InitiateUploadRequest,
            "original_filename",
            500,
            {
                "project_id": PROJECT_ID,
                "asset_name": "asset",
                "mime_type": "video/mp4",
                "file_size_bytes": 1,
            },
        ),
        (ShareLinkCreate, "title", 255, {}),
        (MultiShareCreate, "title", 255, {}),
        (ShareLinkUpdate, "title", 255, {}),
    ],
    ids=[
        "project-create-name",
        "project-update-name",
        "asset-update-name",
        "collection-name",
        "metadata-field-name",
        "setup-name",
        "guest-name",
        "guest-email",
        "upload-asset-name",
        "upload-original-filename",
        "share-create-title",
        "multi-share-title",
        "share-update-title",
    ],
)
def test_request_field_accepts_exact_column_limit(model, field, limit, payload):
    model.model_validate({**payload, field: "x" * limit})


def test_project_create_rejects_name_over_column_limit_before_database(
    client, auth_headers, mock_db
):
    response = client.post(
        "/projects",
        json={"name": "x" * 256},
        headers=auth_headers,
    )

    assert response.status_code == 422, response.text
    mock_db.add.assert_not_called()
