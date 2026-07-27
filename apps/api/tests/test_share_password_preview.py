"""Regression tests for #119 — passphrase-protected share preview shows "No content yet".

The dashboard share-link preview (and thumbnail loader) call the public folder-share
endpoints as the *authenticated link creator*. Those endpoints must forward `current_user`
into `validate_share_link_with_session` so the creator-bypass fires; otherwise a
password-protected link returns 403 "Password required" and the frontend renders an
empty "No content yet" state even though the link contains assets.

The stream endpoint (`/share/{token}/stream/{asset_id}`) already does this correctly;
these tests cover the two endpoints that previously omitted it.
"""
import uuid
from unittest.mock import MagicMock, patch

from apps.api.middleware.auth import get_optional_user
from apps.api.main import app


def _password_link_owned_by(user, *, project_id=None, folder_id=None):
    """A password-protected ShareLink whose creator is `user`."""
    link = MagicMock()
    link.id = uuid.uuid4()
    link.password_hash = "$2b$12$hashvalue"
    link.created_by = user.id
    link.project_id = project_id
    link.folder_id = folder_id
    link.allow_download = False
    link.permission = "comment"
    return link


@patch("apps.api.services.permissions.verify_share_session")
@patch("apps.api.services.permissions.validate_share_link")
def test_folder_share_assets_creator_bypasses_password(
    mock_validate_link, mock_verify_session, client, mock_db, test_user
):
    """The authenticated creator viewing the preview must get 200 (not 403) for a
    password-protected project/folder share — no share_session provided."""
    # Resolve the optional bearer to the link creator.
    app.dependency_overrides[get_optional_user] = lambda: test_user

    link = _password_link_owned_by(test_user, project_id=uuid.uuid4())
    mock_validate_link.return_value = link

    # Make the inline query chains resolve to an empty (but valid) result set.
    mock_db.order_by.return_value = mock_db
    mock_db.offset.return_value = mock_db
    mock_db.limit.return_value = mock_db
    mock_db.scalar.return_value = 0
    mock_db.all.return_value = []

    response = client.get("/share/some-token/assets?page=1&per_page=50")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["assets"] == []
    assert body["subfolders"] == []
    # The creator bypass must be reached without ever consulting a share session.
    mock_verify_session.assert_not_called()


@patch("apps.api.routers.share.generate_presigned_get_url")
@patch("apps.api.routers.share._get_latest_media_file")
@patch("apps.api.routers.share.validate_asset_in_share")
@patch("apps.api.routers.share._get_asset")
@patch("apps.api.services.permissions.verify_share_session")
@patch("apps.api.services.permissions.validate_share_link")
def test_share_thumbnail_creator_bypasses_password(
    mock_validate_link,
    mock_verify_session,
    mock_get_asset,
    mock_validate_in_share,
    mock_get_latest_media_file,
    mock_presign,
    client,
    mock_db,
    test_user,
):
    """Same creator-bypass wiring for `/share/{token}/thumbnail/{asset_id}`."""
    app.dependency_overrides[get_optional_user] = lambda: test_user

    asset_id = uuid.uuid4()
    link = _password_link_owned_by(test_user, project_id=uuid.uuid4())
    mock_validate_link.return_value = link

    asset = MagicMock()
    asset.id = asset_id
    mock_get_asset.return_value = asset
    mock_validate_in_share.return_value = None

    media_file = MagicMock()
    media_file.s3_key_thumbnail = "thumbnails/proj/asset.webp"
    mock_get_latest_media_file.return_value = media_file
    mock_presign.side_effect = lambda key, **kwargs: f"https://s3.example/{key}?sig=x"

    response = client.get(f"/share/some-token/thumbnail/{asset_id}")

    assert response.status_code == 200, response.text
    assert response.json()["url"].startswith("https://s3.example/")
    mock_verify_session.assert_not_called()
