"""Regression test for issue #45 — share endpoint must return master.m3u8 for video assets."""
import uuid
from unittest.mock import MagicMock, patch


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
    assert body["asset"]["stream_url"] is not None
    assert body["asset"]["stream_url"].startswith(
        "https://s3.example/processed/proj/version-abc/master.m3u8"
    ), f"Expected master.m3u8 suffix, got: {body['asset']['stream_url']}"


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
