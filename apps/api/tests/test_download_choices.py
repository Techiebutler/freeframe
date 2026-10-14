"""A download is a choice between the original upload and the transcode.

"Download" used to hand out whatever the server picked -- the top rung's MP4
for a video, the MP3 or WebP for audio and stills -- with no way to get the
file that was actually uploaded. The menu now lists the original and whichever
transcode already exists as a single file, and the stream endpoint serves the
one asked for. Nothing new is produced to offer a choice: a video's lower rungs
are HLS segments, not files, and are not on the list.
"""
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from apps.api.models.asset import AssetType, ProcessingStatus
from apps.api.services import downloads


def _media_file(**overrides):
    fields = dict(
        version_id=uuid.uuid4(),
        s3_key_raw="raw/p/a/v/original.mov",
        s3_key_processed="processed/p/a/v",
        s3_key_download="processed/p/a/v/download.mp4",
        s3_key_thumbnail=None,
        original_filename="Hero Spot.mov",
        file_size_bytes=5_000_000_000,
    )
    fields.update(overrides)
    return SimpleNamespace(**fields)


# ─────────────────────────────────── what is on offer

def test_a_video_offers_its_original_and_its_mp4():
    choices = downloads.download_choices(AssetType.video, _media_file())

    assert [(c.id, c.format, c.s3_key) for c in choices] == [
        ("original", "MOV", "raw/p/a/v/original.mov"),
        ("transcode", "MP4", "processed/p/a/v/download.mp4"),
    ]
    # The original's size is on the row; nobody has to ask storage for it.
    assert choices[0].size_bytes == 5_000_000_000


def test_a_video_with_no_mp4_offers_only_the_original():
    # Transcoded before the MP4 existed, or its remux failed: the ladder is
    # segments, so there is no transcode file to hand out.
    choices = downloads.download_choices(AssetType.video, _media_file(s3_key_download=None))
    assert [c.id for c in choices] == ["original"]


def test_audio_and_stills_offer_their_single_transcode():
    audio = downloads.download_choices(AssetType.audio, _media_file(
        s3_key_raw="raw/p/a/v/original.wav", s3_key_processed="processed/p/a/v/processed.mp3",
        s3_key_download=None,
    ))
    assert [(c.id, c.format) for c in audio] == [("original", "WAV"), ("transcode", "MP3")]

    still = downloads.download_choices(AssetType.image, _media_file(
        s3_key_raw="raw/p/a/v/original.png", s3_key_processed="processed/p/a/v/image.webp",
        s3_key_download=None,
    ))
    assert [(c.id, c.format) for c in still] == [("original", "PNG"), ("transcode", "WEBP")]


def test_no_choice_made_serves_what_a_download_always_served():
    # Any client that does not ask -- bulk download, an older frontend -- gets
    # the same file it did before there was a menu.
    assert downloads.pick_download(AssetType.video, _media_file(), None).id == "transcode"
    assert downloads.pick_download(
        AssetType.video, _media_file(s3_key_download=None), None
    ).id == "original"


def test_a_choice_the_version_does_not_have_is_refused():
    assert downloads.pick_download(AssetType.video, _media_file(), "720p") is None
    assert downloads.pick_download(
        AssetType.video, _media_file(s3_key_download=None), "transcode"
    ) is None


# ─────────────────────────────────── what the menu shows

def _s3_with_master(body: str):
    s3 = MagicMock()
    s3.get_object.return_value = {"Body": MagicMock(read=lambda: body.encode())}
    return s3


def test_the_video_transcode_is_labelled_with_its_rung():
    master = (
        "#EXTM3U\n"
        "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n0/playlist.m3u8\n"
        "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n1/playlist.m3u8\n"
    )
    mf = _media_file()
    choices = downloads.download_choices(AssetType.video, mf)
    with patch.object(downloads, "get_s3_client", return_value=_s3_with_master(master)), \
         patch.object(downloads, "head_object_size", return_value=900_000_000):
        downloads.describe_choices(AssetType.video, mf, choices)

    assert choices[1].label == "1080p"
    assert choices[1].size_bytes == 900_000_000
    assert choices[0].size_bytes == 5_000_000_000


def test_storage_that_will_not_answer_leaves_a_working_menu():
    mf = _media_file()
    choices = downloads.download_choices(AssetType.video, mf)
    broken = MagicMock()
    broken.get_object.side_effect = RuntimeError("connection refused")
    with patch.object(downloads, "get_s3_client", return_value=broken), \
         patch.object(downloads, "head_object_size", side_effect=RuntimeError("nope")):
        downloads.describe_choices(AssetType.video, mf, choices)

    assert [c.label for c in choices] == ["Original", "Transcode"]
    assert choices[1].size_bytes is None


# ─────────────────────────────────── the endpoints

def _video_asset(mock_db, media_file):
    mock_db.order_by.return_value = mock_db

    asset = MagicMock()
    asset.id = uuid.uuid4()
    asset.project_id = uuid.uuid4()
    asset.asset_type = AssetType.video
    asset.name = "Hero Spot"
    asset.deleted_at = None

    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = asset.id
    version.processing_status = ProcessingStatus.ready
    version.deleted_at = None

    mock_db.first.side_effect = [asset, version, media_file]
    return asset


@patch("apps.api.routers.assets.generate_presigned_get_url")
@patch("apps.api.routers.assets.require_asset_access")
def test_choosing_the_original_downloads_the_master_under_its_own_extension(
    mock_require_access, mock_presign, client, mock_db, auth_headers,
):
    asset = _video_asset(mock_db, _media_file())
    mock_presign.return_value = "https://s3.example.com/original.mov?sig=x"

    response = client.get(
        f"/assets/{asset.id}/stream?download=true&rendition=original", headers=auth_headers
    )

    assert response.status_code == 200, response.text
    assert mock_presign.call_args[0][0] == "raw/p/a/v/original.mov"
    assert mock_presign.call_args.kwargs["download_filename"] == "Hero Spot.mov"


@patch("apps.api.routers.assets.generate_presigned_get_url")
@patch("apps.api.routers.assets.require_asset_access")
def test_choosing_the_transcode_downloads_the_mp4(
    mock_require_access, mock_presign, client, mock_db, auth_headers,
):
    asset = _video_asset(mock_db, _media_file())
    mock_presign.return_value = "https://s3.example.com/download.mp4?sig=x"

    response = client.get(
        f"/assets/{asset.id}/stream?download=true&rendition=transcode", headers=auth_headers
    )

    assert response.status_code == 200, response.text
    assert mock_presign.call_args[0][0] == "processed/p/a/v/download.mp4"
    assert mock_presign.call_args.kwargs["download_filename"] == "Hero Spot.mp4"


@patch("apps.api.routers.assets.generate_presigned_get_url")
@patch("apps.api.routers.assets.require_asset_access")
def test_asking_for_a_file_that_does_not_exist_is_a_404(
    mock_require_access, mock_presign, client, mock_db, auth_headers,
):
    asset = _video_asset(mock_db, _media_file(s3_key_download=None))

    response = client.get(
        f"/assets/{asset.id}/stream?download=true&rendition=transcode", headers=auth_headers
    )

    assert response.status_code == 404
    mock_presign.assert_not_called()


@patch("apps.api.services.downloads.head_object_size", return_value=None)
@patch("apps.api.services.downloads.get_s3_client")
@patch("apps.api.routers.assets.require_asset_access")
def test_the_downloads_endpoint_lists_the_choices(
    mock_require_access, mock_s3, mock_head, client, mock_db, auth_headers,
):
    mock_s3.return_value = _s3_with_master(
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\n0/playlist.m3u8\n"
    )
    asset = _video_asset(mock_db, _media_file())

    response = client.get(f"/assets/{asset.id}/downloads", headers=auth_headers)

    assert response.status_code == 200, response.text
    assert response.json() == [
        {"id": "original", "label": "Original", "format": "MOV", "size_bytes": 5_000_000_000},
        {"id": "transcode", "label": "720p", "format": "MP4", "size_bytes": None},
    ]


def _share_link(allow_download=True):
    link = MagicMock()
    link.id = uuid.uuid4()
    link.allow_download = allow_download
    link.permission = "view"
    link.show_versions = False
    return link


def _share_asset():
    asset = MagicMock()
    asset.id = uuid.uuid4()
    asset.name = "Hero Spot"
    asset.asset_type = AssetType.video
    asset.project_id = uuid.uuid4()
    return asset


@patch("apps.api.routers.share._get_asset")
@patch("apps.api.routers.share.validate_share_link_with_session")
def test_a_share_link_without_downloads_lists_nothing(
    mock_validate, mock_get_asset, client, mock_db,
):
    mock_validate.return_value = _share_link(allow_download=False)
    asset = _share_asset()
    mock_get_asset.return_value = asset

    response = client.get(f"/share/some-token/downloads/{asset.id}")

    assert response.status_code == 403
    mock_get_asset.assert_not_called()


@patch("apps.api.routers.share._log_share_activity")
@patch("apps.api.routers.share.generate_presigned_get_url")
@patch("apps.api.routers.share._get_latest_media_file")
@patch("apps.api.routers.share._get_asset")
@patch("apps.api.routers.share.validate_asset_in_share")
@patch("apps.api.routers.share.validate_share_link_with_session")
def test_a_share_link_download_can_be_the_original(
    mock_validate, mock_validate_in_share, mock_get_asset,
    mock_get_latest_media_file, mock_presign, mock_log_activity,
    client, mock_db,
):
    mock_validate.return_value = _share_link()
    asset = _share_asset()
    mock_get_asset.return_value = asset
    mock_get_latest_media_file.return_value = _media_file(duration_seconds=12.0)
    mock_presign.return_value = "https://s3.example.com/original.mov?sig=x"

    response = client.get(
        f"/share/some-token/stream/{asset.id}?download=true&rendition=original"
    )

    assert response.status_code == 200, response.text
    assert mock_presign.call_args_list[0][0][0] == "raw/p/a/v/original.mov"
    assert mock_presign.call_args_list[0].kwargs["download_filename"] == "Hero Spot.mov"
