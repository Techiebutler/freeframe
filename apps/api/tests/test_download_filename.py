"""A download's filename has to describe the bytes behind it.

An audio master is served as the MP3 the transcode produced and a still as the
WebP, but the name was always built from the upload's own filename, so a `.wav`
upload downloaded as `Mix.wav` carrying MP3 bytes and a `.png` as `Poster.png`
carrying WebP. Most image tools and several players refuse that outright.

Pinned here at both levels: the naming rule itself, and the two endpoints that
hand a download out (`/assets/{id}/stream?download=true` and the share-link
equivalent), since the rule can be right and a call site still pass the wrong
source.
"""
import uuid
from unittest.mock import MagicMock, patch

from apps.api.services.s3_service import build_download_filename


# ─────────────────────────────────── the rule

def test_the_extension_comes_from_the_bytes_served_not_the_upload():
    # Mix.wav in, MP3 out: the name has to follow the bytes...
    assert build_download_filename(
        "Mix.wav", "processed/p/a/v/processed.mp3", "Mix.wav"
    ) == "Mix.mp3"
    # ...and the stem is what the user recognises, so it survives.
    assert build_download_filename(
        "Poster.png", "processed/p/a/v/processed.webp", "Poster.png"
    ) == "Poster.webp"


def test_a_served_original_keeps_its_own_extension():
    assert build_download_filename(
        "Interview.mov", "raw/p/a/v/original.mov", "Interview.mov"
    ) == "Interview.mov"


def test_a_display_name_without_an_extension_just_gains_one():
    assert build_download_filename(
        "Third act", "processed/p/a/v/processed.mp3", "third_act.wav"
    ) == "Third act.mp3"


def test_a_dot_in_a_display_name_is_not_treated_as_an_extension():
    # A display name is free text, so only a media extension is replaced;
    # "Scene 2.5" keeps all of itself.
    assert build_download_filename(
        "Scene 2.5", "raw/p/a/v/original.mov", "scene25.mov"
    ) == "Scene 2.5.mov"


def test_a_stale_extension_on_the_name_is_replaced_not_stacked():
    # Measured on the dev instance: this asset is named `.png`, was uploaded as
    # a `.jpg` and is served as the WebP, and downloaded as
    # "freeframe-logowithname croped.png.jpg" -- an extension matching neither
    # the name nor the bytes.
    assert build_download_filename(
        "freeframe-logowithname croped.png",
        "processed/p/a/v/processed.webp",
        "freeframe-logowithname croped.jpg",
    ) == "freeframe-logowithname croped.webp"


def test_an_unusual_upload_extension_is_replaceable_because_the_upload_had_it():
    # .r3d is not on the media allowlist, but this name demonstrably came from
    # the uploaded file, so it is the upload's extension rather than free text.
    assert build_download_filename(
        "A047_C003.r3d", "processed/p/a/v/download.mp4", "A047_C003.r3d"
    ) == "A047_C003.mp4"


def test_a_key_with_no_extension_falls_back_to_the_upload_name():
    # A video's processed key is the HLS prefix, which has no extension at all.
    assert build_download_filename(
        "Interview", "processed/p/a/v", "Interview.mov"
    ) == "Interview.mov"


def test_nothing_to_go_on_leaves_the_name_alone():
    assert build_download_filename("Interview", "", None) == "Interview"


# ─────────────────────────────────── the endpoints

def _media_file(processed: str, raw: str, original: str) -> MagicMock:
    mf = MagicMock()
    mf.s3_key_processed = processed
    mf.s3_key_raw = raw
    mf.s3_key_download = None
    mf.s3_key_thumbnail = None
    mf.original_filename = original
    return mf


def _audio_asset(mock_db, name: str, asset_type):
    from apps.api.models.asset import ProcessingStatus

    mock_db.order_by.return_value = mock_db

    asset = MagicMock()
    asset.id = uuid.uuid4()
    asset.project_id = uuid.uuid4()
    asset.asset_type = asset_type
    asset.name = name
    asset.deleted_at = None

    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = asset.id
    version.processing_status = ProcessingStatus.ready
    version.deleted_at = None

    return asset, version


@patch("apps.api.routers.assets.generate_presigned_get_url")
@patch("apps.api.routers.assets.require_asset_access")
def test_audio_download_is_named_for_the_mp3_it_serves(
    mock_require_access, mock_presign, client, mock_db, auth_headers,
):
    from apps.api.models.asset import AssetType

    asset, version = _audio_asset(mock_db, "Mix.wav", AssetType.audio)
    media_file = _media_file(
        "processed/p/a/v/processed.mp3", "raw/p/a/v/original.wav", "Mix.wav"
    )
    mock_db.first.side_effect = [asset, version, media_file]
    mock_require_access.return_value = None
    mock_presign.return_value = "https://s3.example.com/processed.mp3?sig=x"

    response = client.get(
        f"/assets/{asset.id}/stream?download=true", headers=auth_headers
    )

    assert response.status_code == 200, response.text
    assert mock_presign.call_args[0][0] == "processed/p/a/v/processed.mp3"
    assert mock_presign.call_args.kwargs["download_filename"] == "Mix.mp3"


@patch("apps.api.routers.assets.generate_presigned_get_url")
@patch("apps.api.routers.assets.require_asset_access")
def test_image_download_is_named_for_the_webp_it_serves(
    mock_require_access, mock_presign, client, mock_db, auth_headers,
):
    from apps.api.models.asset import AssetType

    asset, version = _audio_asset(mock_db, "Poster.png", AssetType.image)
    media_file = _media_file(
        "processed/p/a/v/processed.webp", "raw/p/a/v/original.png", "Poster.png"
    )
    mock_db.first.side_effect = [asset, version, media_file]
    mock_require_access.return_value = None
    mock_presign.return_value = "https://s3.example.com/processed.webp?sig=x"

    response = client.get(
        f"/assets/{asset.id}/stream?download=true", headers=auth_headers
    )

    assert response.status_code == 200, response.text
    assert mock_presign.call_args.kwargs["download_filename"] == "Poster.webp"


@patch("apps.api.routers.share._log_share_activity")
@patch("apps.api.routers.share.generate_presigned_get_url")
@patch("apps.api.routers.share._get_latest_media_file")
@patch("apps.api.routers.share._get_asset")
@patch("apps.api.routers.share.validate_asset_in_share")
@patch("apps.api.routers.share.validate_share_link_with_session")
def test_a_share_link_download_is_named_the_same_way(
    mock_validate, mock_validate_in_share, mock_get_asset,
    mock_get_latest_media_file, mock_presign, mock_log_activity,
    client, mock_db,
):
    from apps.api.models.asset import AssetType

    asset_id = uuid.uuid4()

    link = MagicMock()
    link.id = uuid.uuid4()
    link.asset_id = asset_id
    link.allow_download = True
    link.permission = "view"
    link.show_versions = False
    mock_validate.return_value = link
    mock_validate_in_share.return_value = None
    mock_log_activity.return_value = None

    asset = MagicMock()
    asset.id = asset_id
    asset.name = "Mix.wav"
    asset.asset_type = AssetType.audio
    asset.project_id = uuid.uuid4()
    mock_get_asset.return_value = asset

    mock_get_latest_media_file.return_value = _media_file(
        "processed/p/a/v/processed.mp3", "raw/p/a/v/original.wav", "Mix.wav"
    )
    mock_presign.return_value = "https://s3.example.com/processed.mp3?sig=x"

    response = client.get(f"/share/some-token/stream/{asset_id}?download=true")

    assert response.status_code == 200, response.text
    # The first presign is the download; the endpoint presigns a thumbnail after it.
    assert mock_presign.call_args_list[0].kwargs["download_filename"] == "Mix.mp3"
