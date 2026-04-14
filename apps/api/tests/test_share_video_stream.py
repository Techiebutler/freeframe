"""Regression tests for share-link video streaming.

#45 — share endpoint must return master.m3u8 (not the HLS folder) for video.
#51 — all video HLS traffic must route through /stream/hls so S3 can stay private.
"""
import uuid
from unittest.mock import MagicMock, patch

from jose import jwt

from apps.api.config import settings


@patch("apps.api.routers.share.generate_presigned_get_url")
@patch("apps.api.routers.share._get_latest_media_file")
@patch("apps.api.routers.share._get_asset")
@patch("apps.api.routers.share.validate_share_link")
def test_validate_share_link_video_returns_master_m3u8(
    mock_validate,
    mock_get_asset,
    mock_get_latest_media_file,
    mock_presign,
    client,
    mock_db,
):
    from apps.api.models.asset import AssetType

    asset_id = uuid.uuid4()
    project_id = uuid.uuid4()

    link = MagicMock()
    link.id = uuid.uuid4()
    link.asset_id = asset_id
    link.folder_id = None
    link.project_id = None
    link.visibility = "public"
    link.password_hash = None
    link.title = "test"
    link.description = None
    link.permission = "view"
    link.allow_download = False
    link.show_versions = False
    link.show_watermark = False
    link.appearance = None
    link.created_by = uuid.uuid4()
    mock_validate.return_value = link

    asset = MagicMock()
    asset.id = asset_id
    asset.name = "demo video"
    asset.asset_type = AssetType.video
    asset.description = None
    asset.project_id = project_id
    mock_get_asset.return_value = asset

    media_file = MagicMock()
    media_file.s3_key_processed = "processed/proj/version-abc"
    media_file.s3_key_raw = "raw/proj/version-abc/input.mp4"
    media_file.s3_key_thumbnail = None
    mock_get_latest_media_file.return_value = media_file

    mock_db.first.return_value = None
    mock_presign.side_effect = lambda key, **kwargs: f"https://s3.example/{key}?sig=x"

    response = client.get("/share/some-token")

    assert response.status_code == 200
    body = response.json()
    assert body["asset"] is not None
    stream_url = body["asset"]["stream_url"]
    assert stream_url is not None

    # #51: video stream URLs must route through the HLS proxy, not directly to S3.
    assert stream_url.startswith("/stream/hls/master.m3u8?token="), (
        f"Expected /stream/hls/master.m3u8?token=..., got: {stream_url}"
    )
    assert "s3.example" not in stream_url, (
        f"Stream URL must not contain a presigned S3 URL, got: {stream_url}"
    )

    # The token must be scoped to this version's S3 prefix — never the bucket.
    token = stream_url.split("token=", 1)[1]
    payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    assert payload["sub"] == "hls"
    assert payload["pfx"] == "processed/proj/version-abc"


@patch("apps.api.routers.share.generate_presigned_get_url")
@patch("apps.api.routers.share._get_latest_media_file")
@patch("apps.api.routers.share._get_asset")
@patch("apps.api.routers.share.validate_share_link")
def test_validate_share_link_image_does_not_append_master_m3u8(
    mock_validate,
    mock_get_asset,
    mock_get_latest_media_file,
    mock_presign,
    client,
    mock_db,
):
    from apps.api.models.asset import AssetType

    asset_id = uuid.uuid4()
    project_id = uuid.uuid4()

    link = MagicMock()
    link.id = uuid.uuid4()
    link.asset_id = asset_id
    link.folder_id = None
    link.project_id = None
    link.visibility = "public"
    link.password_hash = None
    link.title = "test"
    link.description = None
    link.permission = "view"
    link.allow_download = False
    link.show_versions = False
    link.show_watermark = False
    link.appearance = None
    link.created_by = uuid.uuid4()
    mock_validate.return_value = link

    asset = MagicMock()
    asset.id = asset_id
    asset.name = "demo image"
    asset.asset_type = AssetType.image
    asset.description = None
    asset.project_id = project_id
    mock_get_asset.return_value = asset

    media_file = MagicMock()
    media_file.s3_key_processed = "processed/proj/version-img/out.webp"
    media_file.s3_key_raw = "raw/proj/version-img/input.jpg"
    media_file.s3_key_thumbnail = None
    mock_get_latest_media_file.return_value = media_file

    mock_db.first.return_value = None
    mock_presign.side_effect = lambda key, **kwargs: f"https://s3.example/{key}?sig=x"

    response = client.get("/share/some-token")

    assert response.status_code == 200
    body = response.json()
    assert body["asset"]["stream_url"] is not None
    assert "master.m3u8" not in body["asset"]["stream_url"]
    assert body["asset"]["stream_url"].startswith(
        "https://s3.example/processed/proj/version-img/out.webp"
    )


@patch("apps.api.routers.share._validate_asset_in_share")
@patch("apps.api.routers.share._log_share_activity")
@patch("apps.api.routers.share._get_latest_media_file")
@patch("apps.api.routers.share._get_asset")
@patch("apps.api.routers.share.validate_share_link_with_session")
def test_share_stream_endpoint_video_returns_hls_proxy_url(
    mock_validate,
    mock_get_asset,
    mock_get_latest_media_file,
    mock_log_activity,
    mock_validate_in_share,
    client,
    mock_db,
):
    """#51 — /share/{token}/stream/{asset_id} must also route video through /stream/hls."""
    from apps.api.models.asset import AssetType

    asset_id = uuid.uuid4()

    link = MagicMock()
    link.id = uuid.uuid4()
    link.asset_id = asset_id
    link.allow_download = False
    link.permission = "view"
    mock_validate.return_value = link
    mock_validate_in_share.return_value = None
    mock_log_activity.return_value = None

    asset = MagicMock()
    asset.id = asset_id
    asset.name = "stream endpoint video"
    asset.asset_type = AssetType.video
    asset.project_id = uuid.uuid4()
    mock_get_asset.return_value = asset

    media_file = MagicMock()
    media_file.s3_key_processed = "processed/proj/version-stream"
    media_file.s3_key_raw = "raw/proj/version-stream/input.mp4"
    media_file.s3_key_thumbnail = None
    media_file.version_id = uuid.uuid4()
    media_file.duration_seconds = 120.0
    mock_get_latest_media_file.return_value = media_file

    response = client.get(f"/share/some-token/stream/{asset_id}")

    assert response.status_code == 200, response.text
    body = response.json()
    url = body["url"]

    assert url.startswith("/stream/hls/master.m3u8?token="), (
        f"Expected /stream/hls/master.m3u8?token=..., got: {url}"
    )

    token = url.split("token=", 1)[1]
    payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    assert payload["sub"] == "hls"
    assert payload["pfx"] == "processed/proj/version-stream"
