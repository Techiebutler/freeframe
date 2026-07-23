"""Tests for version-aware public share endpoints (share-link versioning).

Note: the suite uses a mock Session, so SQL-level filtering (e.g. Comment.version_id ==,
version selection in the stream endpoint) is not executed here — that behaviour is covered
end-to-end. These tests pin the Python-level contract: the show_versions gating on the guest
versions endpoint, and that the new version_id params are accepted without regressions.
"""
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


def _ready_version(number: int):
    return SimpleNamespace(
        id=uuid.uuid4(),
        version_number=number,
        processing_status="ready",
        created_at=datetime.now(timezone.utc),
    )


@patch("apps.api.routers.share.validate_asset_in_share")
@patch("apps.api.routers.share._get_asset")
@patch("apps.api.services.permissions.validate_share_link")
def test_guest_versions_returns_all_when_show_versions_enabled(
    mock_validate_link, mock_get_asset, mock_validate_in_share, client, mock_db
):
    link = MagicMock()
    link.password_hash = None
    link.show_versions = True
    mock_validate_link.return_value = link

    asset = MagicMock()
    asset.id = uuid.uuid4()
    mock_get_asset.return_value = asset
    mock_validate_in_share.return_value = None

    # Query returns newest-first (as the endpoint orders); mock does not execute ordering.
    versions = [_ready_version(3), _ready_version(2), _ready_version(1)]
    mock_db.order_by.return_value = mock_db
    mock_db.all.return_value = versions

    resp = client.get(f"/share/tok/assets/{asset.id}/versions")

    assert resp.status_code == 200, resp.text
    assert [v["version_number"] for v in resp.json()] == [3, 2, 1]
    assert all(v["processing_status"] == "ready" for v in resp.json())


@patch("apps.api.routers.share.validate_asset_in_share")
@patch("apps.api.routers.share._get_asset")
@patch("apps.api.services.permissions.validate_share_link")
def test_guest_versions_returns_latest_only_when_hidden(
    mock_validate_link, mock_get_asset, mock_validate_in_share, client, mock_db
):
    link = MagicMock()
    link.password_hash = None
    link.show_versions = False  # version history hidden
    mock_validate_link.return_value = link

    asset = MagicMock()
    asset.id = uuid.uuid4()
    mock_get_asset.return_value = asset
    mock_validate_in_share.return_value = None

    versions = [_ready_version(3), _ready_version(2), _ready_version(1)]
    mock_db.order_by.return_value = mock_db
    mock_db.all.return_value = versions

    resp = client.get(f"/share/tok/assets/{asset.id}/versions")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body) == 1
    assert body[0]["version_number"] == 3  # only the latest ready version is exposed


@patch("apps.api.routers.comments._build_comment_response")
@patch("apps.api.routers.comments.validate_asset_in_share")
@patch("apps.api.routers.comments._get_asset")
@patch("apps.api.routers.comments.validate_share_link_with_session")
def test_share_comments_accepts_version_id(
    mock_validate_link, mock_get_asset, mock_validate_in_share, mock_build, client, mock_db
):
    link = MagicMock()
    link.asset_id = None
    mock_validate_link.return_value = link

    asset = MagicMock()
    asset.id = uuid.uuid4()
    mock_get_asset.return_value = asset
    mock_validate_in_share.return_value = None

    mock_db.order_by.return_value = mock_db
    mock_db.all.return_value = []

    resp = client.get(
        f"/share/tok/comments?asset_id={asset.id}&version_id={uuid.uuid4()}"
    )

    assert resp.status_code == 200, resp.text
    assert resp.json() == []
    mock_build.assert_not_called()


@patch("apps.api.routers.comments._build_comment_response")
@patch("apps.api.routers.comments.validate_asset_in_share")
@patch("apps.api.routers.comments._get_asset")
@patch("apps.api.routers.comments.validate_share_link_with_session")
def test_share_comments_accepts_latest_only(
    mock_validate_link, mock_get_asset, mock_validate_in_share, mock_build, client, mock_db
):
    """The folder/grid preview scopes to the latest ready version via latest_only=true."""
    link = MagicMock()
    link.asset_id = None
    mock_validate_link.return_value = link

    asset = MagicMock()
    asset.id = uuid.uuid4()
    mock_get_asset.return_value = asset
    mock_validate_in_share.return_value = None

    mock_db.order_by.return_value = mock_db
    mock_db.first.return_value = None  # no ready version resolved
    mock_db.all.return_value = []

    resp = client.get(f"/share/tok/comments?asset_id={asset.id}&latest_only=true")

    assert resp.status_code == 200, resp.text
    assert resp.json() == []
