"""Regression coverage for bounded request text stored in varchar columns."""

import uuid

import pytest
from pydantic import ValidationError

from apps.api.routers.setup import CreateSuperAdminRequest
from apps.api.schemas.comment import GuestCommentCreate


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
def test_overlong_request_fields_return_422(client, auth_headers, method, path, payload):
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


def test_guest_email_must_be_a_valid_email_address():
    with pytest.raises(ValidationError):
        GuestCommentCreate(body="hello", guest_email="not-an-email")


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
