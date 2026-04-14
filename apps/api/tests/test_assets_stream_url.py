"""Regression tests for issue #51 — /assets/{id}/stream must route video HLS
through the /stream/hls proxy so S3 objects can stay private."""
import uuid
from unittest.mock import MagicMock, patch

from jose import jwt

from apps.api.config import settings


def _setup_video_asset(mock_db, asset_type):
    from apps.api.models.asset import ProcessingStatus

    # The conftest mock_db only chains query/filter back to itself — order_by
    # creates a new auto-mock otherwise, so .first() wouldn't return our values.
    mock_db.order_by.return_value = mock_db

    asset = MagicMock()
    asset.id = uuid.uuid4()
    asset.project_id = uuid.uuid4()
    asset.asset_type = asset_type
    asset.name = "demo"
    asset.deleted_at = None

    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = asset.id
    version.processing_status = ProcessingStatus.ready
    version.deleted_at = None

    media_file = MagicMock()
    media_file.version_id = version.id
    media_file.s3_key_processed = "processed/proj/version-xyz"
    media_file.s3_key_raw = "raw/proj/version-xyz/input.mp4"
    media_file.original_filename = "input.mp4"

    mock_db.first.side_effect = [asset, version, media_file]
    return asset, version, media_file


@patch("apps.api.routers.assets.require_asset_access")
def test_video_stream_returns_hls_proxy_url_with_token(
    mock_require_access,
    client,
    mock_db,
    auth_headers,
):
    from apps.api.models.asset import AssetType

    asset, _, media_file = _setup_video_asset(mock_db, AssetType.video)
    mock_require_access.return_value = None

    response = client.get(f"/assets/{asset.id}/stream", headers=auth_headers)

    assert response.status_code == 200, response.text
    body = response.json()
    url = body["url"]

    # The URL must route through the HLS proxy, not directly to S3.
    assert url.startswith("/stream/hls/master.m3u8?token="), (
        f"Expected /stream/hls/master.m3u8?token=..., got: {url}"
    )
    assert "s3" not in url.lower(), (
        f"Stream URL must not contain a presigned S3 URL, got: {url}"
    )

    # The token must be a valid HLS JWT scoped to this asset's S3 prefix.
    token = url.split("token=", 1)[1]
    payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    assert payload["sub"] == "hls"
    assert payload["pfx"] == media_file.s3_key_processed
    assert "exp" in payload


@patch("apps.api.routers.assets.generate_presigned_get_url")
@patch("apps.api.routers.assets.require_asset_access")
def test_video_download_still_returns_presigned_raw(
    mock_require_access,
    mock_presign,
    client,
    mock_db,
    auth_headers,
):
    from apps.api.models.asset import AssetType

    asset, _, _ = _setup_video_asset(mock_db, AssetType.video)
    mock_require_access.return_value = None
    mock_presign.return_value = "https://s3.example.com/raw.mp4?sig=x"

    response = client.get(
        f"/assets/{asset.id}/stream?download=true", headers=auth_headers
    )

    assert response.status_code == 200, response.text
    body = response.json()
    # Downloads bypass the HLS proxy — they need the original file, not a playlist.
    assert body["url"] == "https://s3.example.com/raw.mp4?sig=x"
    assert "/stream/hls/" not in body["url"]


@patch("apps.api.routers.assets.generate_presigned_get_url")
@patch("apps.api.routers.assets.require_asset_access")
def test_image_stream_still_returns_presigned(
    mock_require_access,
    mock_presign,
    client,
    mock_db,
    auth_headers,
):
    """Images and audio don't go through the HLS proxy — only video does."""
    from apps.api.models.asset import AssetType

    asset, _, _ = _setup_video_asset(mock_db, AssetType.image)
    mock_require_access.return_value = None
    mock_presign.return_value = "https://s3.example.com/image.webp?sig=x"

    response = client.get(f"/assets/{asset.id}/stream", headers=auth_headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["url"] == "https://s3.example.com/image.webp?sig=x"
    assert "/stream/hls/" not in body["url"]
