"""A download is a choice between the original upload and the transcode.

"Download" used to hand out whatever the server picked -- the top rung's MP4
for a video, the MP3 or WebP for audio and stills -- with no way to get the
file that was actually uploaded. The menu now lists the original and whichever
transcode already exists as a single file, and the stream endpoint serves the
one asked for. Nothing new is produced to offer a choice: a video's lower rungs
are HLS segments, not files, and are not on the list.
"""
import uuid
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

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
    choices = downloads.download_choices(AssetType.video, _media_file(), allow_original=True)

    assert [(c.id, c.format, c.s3_key) for c in choices] == [
        ("original", "MOV", "raw/p/a/v/original.mov"),
        ("transcode", "MP4", "processed/p/a/v/download.mp4"),
    ]
    # The original's size is on the row; nobody has to ask storage for it.
    assert choices[0].size_bytes == 5_000_000_000


def test_a_video_with_no_mp4_offers_only_the_original():
    # Transcoded before the MP4 existed, or its remux failed: the ladder is
    # segments, so there is no transcode file to hand out.
    choices = downloads.download_choices(AssetType.video, _media_file(s3_key_download=None), allow_original=True)
    assert [c.id for c in choices] == ["original"]


def test_audio_and_stills_offer_their_single_transcode():
    audio = downloads.download_choices(AssetType.audio, _media_file(
        s3_key_raw="raw/p/a/v/original.wav", s3_key_processed="processed/p/a/v/processed.mp3",
        s3_key_download=None,
    ), allow_original=True)
    assert [(c.id, c.format) for c in audio] == [("original", "WAV"), ("transcode", "MP3")]

    still = downloads.download_choices(AssetType.image, _media_file(
        s3_key_raw="raw/p/a/v/original.png", s3_key_processed="processed/p/a/v/image.webp",
        s3_key_download=None,
    ), allow_original=True)
    assert [(c.id, c.format) for c in still] == [("original", "PNG"), ("transcode", "WEBP")]


def test_no_choice_made_serves_what_a_download_always_served():
    # Any client that does not ask -- bulk download, an older frontend -- gets
    # the same file it did before there was a menu.
    for allow in (True, False):
        assert downloads.pick_download(
            AssetType.video, _media_file(), None, allow_original=allow
        ).id == "transcode"
        assert downloads.pick_download(
            AssetType.video, _media_file(s3_key_download=None), None, allow_original=allow
        ).id == "original"


def test_a_choice_the_version_does_not_have_is_refused():
    assert downloads.pick_download(AssetType.video, _media_file(), "720p", allow_original=True) is None
    assert downloads.pick_download(
        AssetType.video, _media_file(s3_key_download=None), "transcode", allow_original=True
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
    choices = downloads.download_choices(AssetType.video, mf, allow_original=True)
    with patch.object(downloads, "get_s3_client", return_value=_s3_with_master(master)), \
         patch.object(downloads, "head_object_size", return_value=900_000_000):
        downloads.describe_choices(AssetType.video, mf, choices)

    assert choices[1].label == "1080p"
    assert choices[1].size_bytes == 900_000_000
    assert choices[0].size_bytes == 5_000_000_000


def test_storage_that_will_not_answer_leaves_a_working_menu():
    mf = _media_file()
    choices = downloads.download_choices(AssetType.video, mf, allow_original=True)
    broken = MagicMock()
    broken.get_object.side_effect = RuntimeError("connection refused")
    with patch.object(downloads, "get_s3_client", return_value=broken), \
         patch.object(downloads, "head_object_size", side_effect=RuntimeError("nope")):
        downloads.describe_choices(AssetType.video, mf, choices)

    assert [c.label for c in choices] == ["Original", "Transcode"]
    assert choices[1].size_bytes is None


# ─────────────────────────────────── the endpoints

@pytest.fixture(autouse=True)
def _no_rate_limit():
    with patch("apps.api.middleware.rate_limit.check_rate_limit", return_value=(True, 0)):
        yield


@pytest.fixture
def member():
    """The caller is a member of the asset's project; the instance setting is off."""
    with patch("apps.api.services.downloads.get_project_member", return_value=MagicMock()), \
         patch("apps.api.services.downloads.get_allow_original_downloads", return_value=False):
        yield


def _outsider(allow_original_downloads=False):
    """Not a member, so only the instance setting decides."""
    return _patches(
        patch("apps.api.services.downloads.get_project_member", return_value=None),
        patch("apps.api.services.downloads.get_allow_original_downloads",
              return_value=allow_original_downloads),
    )


def _patches(*ps):
    stack = ExitStack()
    for p in ps:
        stack.enter_context(p)
    return stack

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
    mock_require_access, mock_presign, client, mock_db, auth_headers, member,
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
    mock_require_access, mock_presign, client, mock_db, auth_headers, member,
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
    mock_require_access, mock_presign, client, mock_db, auth_headers, member,
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
    mock_require_access, mock_s3, mock_head, client, mock_db, auth_headers, member,
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
def test_a_share_link_download_can_be_the_original_when_the_instance_allows_it(
    mock_validate, mock_validate_in_share, mock_get_asset,
    mock_get_latest_media_file, mock_presign, mock_log_activity,
    client, mock_db,
):
    mock_validate.return_value = _share_link()
    asset = _share_asset()
    mock_get_asset.return_value = asset
    mock_get_latest_media_file.return_value = _media_file(duration_seconds=12.0)
    mock_presign.return_value = "https://s3.example.com/original.mov?sig=x"

    with _outsider(allow_original_downloads=True):
        response = client.get(
            f"/share/some-token/stream/{asset.id}?download=true&rendition=original"
        )

    assert response.status_code == 200, response.text
    assert mock_presign.call_args_list[0][0][0] == "raw/p/a/v/original.mov"
    assert mock_presign.call_args_list[0].kwargs["download_filename"] == "Hero Spot.mov"
    assert mock_log_activity.call_args.kwargs["rendition"] == "original"


# ─────────────────────────────────── who may have the original
#
# Members of the project can always download the original. Anyone else -- a
# share-link visitor, a non-member of a public project, a direct share -- gets
# the transcode unless an admin turns on allow_original_downloads. Off, they get
# exactly what a download served before there was a choice.

def test_without_the_original_a_video_offers_only_its_transcode():
    choices = downloads.download_choices(AssetType.video, _media_file(), allow_original=False)
    assert [c.id for c in choices] == ["transcode"]


def test_without_the_original_a_video_with_no_mp4_still_offers_its_master():
    # The fallback main has always had: nothing else can be downloaded.
    choices = downloads.download_choices(
        AssetType.video, _media_file(s3_key_download=None), allow_original=False
    )
    assert [c.id for c in choices] == ["original"]


def test_asking_for_the_original_without_leave_is_refused_not_missing():
    with pytest.raises(downloads.OriginalNotAllowed):
        downloads.pick_download(AssetType.video, _media_file(), "original", allow_original=False)


def test_original_allowed_for_download_by_request_kind(mock_db):
    asset = SimpleNamespace(project_id=uuid.uuid4(), created_by=uuid.uuid4())
    member = SimpleNamespace(id=uuid.uuid4())
    with patch("apps.api.services.downloads.get_project_member", return_value=MagicMock()), \
         patch("apps.api.services.downloads.get_allow_original_downloads", return_value=False):
        # Named in the menu: membership is enough.
        assert downloads.original_allowed_for_download(mock_db, asset, member, "original", False)
        # Bulk: the instance setting decides, even for a member.
        assert not downloads.original_allowed_for_download(mock_db, asset, member, None, True)
        # Nothing asked for: the same file for everyone, no lookup needed.
        assert not downloads.original_allowed_for_download(mock_db, asset, member, None, False)


def test_prefer_original_gets_the_original_only_where_allowed():
    mf = _media_file()
    assert downloads.pick_download(
        AssetType.video, mf, None, allow_original=True, prefer_original=True
    ).id == "original"
    assert downloads.pick_download(
        AssetType.video, mf, None, allow_original=False, prefer_original=True
    ).id == "transcode"


def test_creators_and_members_may_have_the_original_and_others_follow_the_setting(mock_db):
    asset = SimpleNamespace(project_id=uuid.uuid4(), created_by=uuid.uuid4())
    creator = SimpleNamespace(id=asset.created_by)
    someone = SimpleNamespace(id=uuid.uuid4())

    with patch("apps.api.services.downloads.get_project_member", return_value=None), \
         patch("apps.api.services.downloads.get_allow_original_downloads", return_value=False):
        assert downloads.may_download_original(mock_db, asset, creator)
        assert not downloads.may_download_original(mock_db, asset, someone)
        assert not downloads.may_download_original(mock_db, asset, None)
    with patch("apps.api.services.downloads.get_project_member", return_value=MagicMock()), \
         patch("apps.api.services.downloads.get_allow_original_downloads", return_value=False):
        assert downloads.may_download_original(mock_db, asset, someone)
    with patch("apps.api.services.downloads.get_project_member", return_value=None), \
         patch("apps.api.services.downloads.get_allow_original_downloads", return_value=True):
        assert downloads.may_download_original(mock_db, asset, None)


def test_the_setting_reads_as_off_before_anyone_saves_it(mock_db):
    from apps.api.services.storage import get_allow_original_downloads
    mock_db.first.return_value = None
    assert get_allow_original_downloads(mock_db) is False


def test_an_mp4_upload_and_its_mp4_transcode_download_under_different_names():
    mf = _media_file(s3_key_raw="raw/p/a/v/original.mp4", original_filename="Portrait.mp4")
    asset = SimpleNamespace(name="Portrait", asset_type=AssetType.video)
    original, transcode = downloads.download_choices(AssetType.video, mf, allow_original=True)
    master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=720x1280\n0/playlist.m3u8\n"

    with patch.object(downloads, "get_s3_client", return_value=_s3_with_master(master)):
        assert downloads.download_filename(asset, mf, original) == "Portrait.mp4"
        assert downloads.download_filename(asset, mf, transcode) == "Portrait (1280p).mp4"


def test_a_transcode_in_another_format_keeps_the_plain_name():
    mf = _media_file()
    asset = SimpleNamespace(name="Hero Spot", asset_type=AssetType.video)
    transcode = downloads.download_choices(AssetType.video, mf, allow_original=True)[1]
    assert downloads.download_filename(asset, mf, transcode) == "Hero Spot.mp4"


# ─────────────────────────────────── /assets: the gates in front of the master

def _outsider_asset(mock_db, media_file):
    asset = _video_asset(mock_db, media_file)
    asset.created_by = uuid.uuid4()
    return asset


@patch("apps.api.routers.assets.generate_presigned_get_url", return_value="https://s3/x")
@patch("apps.api.services.permissions.can_access_asset", return_value=False)
def test_someone_without_access_cannot_list_downloads(
    mock_can_access, mock_presign, client, mock_db, auth_headers, member,
):
    # require_asset_access in _ready_media_file is the gate under test, so it runs
    # for real; only the lookup it makes is answered.
    asset = _video_asset(mock_db, _media_file())

    response = client.get(f"/assets/{asset.id}/downloads", headers=auth_headers)

    assert response.status_code == 403


@patch("apps.api.routers.assets.generate_presigned_get_url", return_value="https://s3/x")
@patch("apps.api.services.permissions.can_access_asset", return_value=False)
def test_someone_without_access_cannot_download_the_original(
    mock_can_access, mock_presign, client, mock_db, auth_headers, member,
):
    asset = _video_asset(mock_db, _media_file())

    response = client.get(
        f"/assets/{asset.id}/stream?download=true&rendition=original", headers=auth_headers
    )

    assert response.status_code == 403
    mock_presign.assert_not_called()


@patch("apps.api.services.downloads.head_object_size", return_value=None)
@patch("apps.api.services.downloads.get_s3_client")
@patch("apps.api.routers.assets.require_asset_access")
def test_a_public_project_visitor_is_not_offered_the_original(
    mock_require_access, mock_s3, mock_head, client, mock_db, auth_headers,
):
    mock_s3.return_value = _s3_with_master("#EXTM3U\n")
    asset = _outsider_asset(mock_db, _media_file())

    with _outsider():
        response = client.get(f"/assets/{asset.id}/downloads", headers=auth_headers)

    assert response.status_code == 200, response.text
    assert [o["id"] for o in response.json()] == ["transcode"]


@patch("apps.api.routers.assets.generate_presigned_get_url", return_value="https://s3/x")
@patch("apps.api.routers.assets.require_asset_access")
def test_a_public_project_visitor_asking_for_the_original_is_refused(
    mock_require_access, mock_presign, client, mock_db, auth_headers,
):
    asset = _outsider_asset(mock_db, _media_file())

    with _outsider():
        response = client.get(
            f"/assets/{asset.id}/stream?download=true&rendition=original", headers=auth_headers
        )

    assert response.status_code == 403
    assert "not enabled" in response.json()["detail"]
    mock_presign.assert_not_called()


@pytest.mark.parametrize("setting, served", [
    (False, "processed/p/a/v/download.mp4"),
    (True, "raw/p/a/v/original.mov"),
])
@patch("apps.api.routers.assets.generate_presigned_get_url", return_value="https://s3/x")
@patch("apps.api.routers.assets.require_asset_access")
def test_a_member_bulk_download_follows_the_instance_setting(
    mock_require_access, mock_presign, client, mock_db, auth_headers, setting, served,
):
    # Bulk fetches a whole selection, so the egress switch governs it even for
    # members, who can still pick Original one asset at a time.
    asset = _video_asset(mock_db, _media_file())

    with patch("apps.api.services.downloads.get_project_member", return_value=MagicMock()), \
         patch("apps.api.services.downloads.get_allow_original_downloads", return_value=setting):
        response = client.get(
            f"/assets/{asset.id}/stream?download=true&prefer_original=true", headers=auth_headers
        )

    assert response.status_code == 200, response.text
    assert mock_presign.call_args[0][0] == served


@patch("apps.api.routers.assets.generate_presigned_get_url", return_value="https://s3/x")
@patch("apps.api.routers.assets.require_asset_access")
def test_an_outsider_bulk_download_gets_the_transcode(
    mock_require_access, mock_presign, client, mock_db, auth_headers,
):
    asset = _outsider_asset(mock_db, _media_file())

    with _outsider():
        response = client.get(
            f"/assets/{asset.id}/stream?download=true&prefer_original=true", headers=auth_headers
        )

    assert response.status_code == 200, response.text
    assert mock_presign.call_args[0][0] == "processed/p/a/v/download.mp4"


# ─────────────────────────────────── share links: the gates in front of the master

def _share_stream(client, asset, query):
    return client.get(f"/share/some-token/stream/{asset.id}?{query}")


@patch("apps.api.routers.share._log_share_activity")
@patch("apps.api.routers.share.generate_presigned_get_url", return_value="https://s3/x")
@patch("apps.api.routers.share._get_latest_media_file")
@patch("apps.api.routers.share._get_asset")
@patch("apps.api.routers.share.validate_asset_in_share")
@patch("apps.api.routers.share.validate_share_link_with_session")
def test_a_link_with_downloads_off_does_not_hand_out_the_original(
    mock_validate, mock_validate_in_share, mock_get_asset,
    mock_get_latest_media_file, mock_presign, mock_log_activity, client, mock_db,
):
    # Everything after the allow_download check would succeed, so only that
    # check stands between this request and the master.
    mock_validate.return_value = _share_link(allow_download=False)
    asset = _share_asset()
    mock_get_asset.return_value = asset
    mock_get_latest_media_file.return_value = _media_file(duration_seconds=12.0)

    with _outsider(allow_original_downloads=True):
        response = _share_stream(client, asset, "download=true&rendition=original")

    assert response.status_code == 403
    mock_presign.assert_not_called()


@patch("apps.api.services.downloads.head_object_size", return_value=None)
@patch("apps.api.services.downloads.get_s3_client")
@patch("apps.api.routers.share._get_latest_media_file")
@patch("apps.api.routers.share._get_asset")
@patch("apps.api.routers.share.validate_share_link_with_session")
def test_a_share_list_for_an_asset_outside_the_link_is_refused(
    mock_validate, mock_get_asset, mock_get_latest_media_file, mock_s3, mock_head,
    client, mock_db,
):
    # validate_asset_in_share runs for real: the link is for one asset, and the
    # request names another.
    link = _share_link()
    link.folder_id = None
    link.asset_id = uuid.uuid4()
    mock_validate.return_value = link
    asset = _share_asset()
    mock_get_asset.return_value = asset
    mock_get_latest_media_file.return_value = _media_file()
    mock_s3.return_value = _s3_with_master("#EXTM3U\n")

    with _outsider(allow_original_downloads=True):
        response = client.get(f"/share/some-token/downloads/{asset.id}")

    assert response.status_code == 403


@patch("apps.api.services.downloads.head_object_size", return_value=None)
@patch("apps.api.services.downloads.get_s3_client")
@patch("apps.api.routers.share._get_latest_media_file")
@patch("apps.api.routers.share._get_asset")
@patch("apps.api.routers.share.validate_asset_in_share")
@patch("apps.api.routers.share.validate_share_link_with_session")
def test_a_share_list_offers_the_original_only_when_the_instance_allows_it(
    mock_validate, mock_validate_in_share, mock_get_asset, mock_get_latest_media_file,
    mock_s3, mock_head, client, mock_db,
):
    mock_validate.return_value = _share_link()
    asset = _share_asset()
    mock_get_asset.return_value = asset
    mock_get_latest_media_file.return_value = _media_file()
    mock_s3.return_value = _s3_with_master("#EXTM3U\n")

    with _outsider(allow_original_downloads=False):
        off = client.get(f"/share/some-token/downloads/{asset.id}")
    with _outsider(allow_original_downloads=True):
        on = client.get(f"/share/some-token/downloads/{asset.id}")

    assert [o["id"] for o in off.json()] == ["transcode"]
    assert [o["id"] for o in on.json()] == ["original", "transcode"]


@patch("apps.api.routers.share._log_share_activity")
@patch("apps.api.routers.share.generate_presigned_get_url", return_value="https://s3/x")
@patch("apps.api.routers.share._get_latest_media_file")
@patch("apps.api.routers.share._get_asset")
@patch("apps.api.routers.share.validate_asset_in_share")
@patch("apps.api.routers.share.validate_share_link_with_session")
def test_a_share_visitor_asking_for_the_original_with_the_setting_off_is_refused(
    mock_validate, mock_validate_in_share, mock_get_asset,
    mock_get_latest_media_file, mock_presign, mock_log_activity, client, mock_db,
):
    mock_validate.return_value = _share_link()
    asset = _share_asset()
    mock_get_asset.return_value = asset
    mock_get_latest_media_file.return_value = _media_file(duration_seconds=12.0)

    with _outsider():
        response = _share_stream(client, asset, "download=true&rendition=original")

    assert response.status_code == 403
    mock_presign.assert_not_called()


@patch("apps.api.routers.share._log_share_activity")
@patch("apps.api.routers.share.generate_presigned_get_url", return_value="https://s3/x")
@patch("apps.api.routers.share._get_latest_media_file")
@patch("apps.api.routers.share._get_asset")
@patch("apps.api.routers.share.validate_asset_in_share")
@patch("apps.api.routers.share.validate_share_link_with_session")
def test_a_share_download_with_no_mp4_still_gets_the_master_with_the_setting_off(
    mock_validate, mock_validate_in_share, mock_get_asset,
    mock_get_latest_media_file, mock_presign, mock_log_activity, client, mock_db,
):
    mock_validate.return_value = _share_link()
    asset = _share_asset()
    mock_get_asset.return_value = asset
    mock_get_latest_media_file.return_value = _media_file(s3_key_download=None, duration_seconds=12.0)

    with _outsider():
        response = _share_stream(client, asset, "download=true")

    assert response.status_code == 200, response.text
    assert mock_presign.call_args_list[0][0][0] == "raw/p/a/v/original.mov"


@patch("apps.api.routers.share._log_share_activity")
@patch("apps.api.routers.share.generate_presigned_get_url", return_value="https://s3/x")
@patch("apps.api.routers.share._get_latest_media_file")
@patch("apps.api.routers.share._get_asset")
@patch("apps.api.routers.share.validate_asset_in_share")
@patch("apps.api.routers.share.validate_share_link_with_session")
def test_download_all_on_a_share_follows_the_setting_and_logs_which_file(
    mock_validate, mock_validate_in_share, mock_get_asset,
    mock_get_latest_media_file, mock_presign, mock_log_activity, client, mock_db,
):
    mock_validate.return_value = _share_link()
    asset = _share_asset()
    mock_get_asset.return_value = asset
    mock_get_latest_media_file.return_value = _media_file(duration_seconds=12.0)

    with _outsider(allow_original_downloads=False):
        _share_stream(client, asset, "download=true&prefer_original=true")
    assert mock_presign.call_args_list[0][0][0] == "processed/p/a/v/download.mp4"
    assert mock_log_activity.call_args.kwargs["rendition"] == "transcode"

    mock_presign.reset_mock()
    with _outsider(allow_original_downloads=True):
        _share_stream(client, asset, "download=true&prefer_original=true")
    assert mock_presign.call_args_list[0][0][0] == "raw/p/a/v/original.mov"
    assert mock_log_activity.call_args.kwargs["rendition"] == "original"


@patch("apps.api.routers.share._log_share_activity")
@patch("apps.api.routers.share.generate_presigned_get_url", return_value="https://s3/x")
@patch("apps.api.routers.share._get_latest_media_file")
@patch("apps.api.routers.share._get_asset")
@patch("apps.api.routers.share.validate_asset_in_share")
@patch("apps.api.routers.share.validate_share_link_with_session")
def test_viewing_logs_no_rendition(
    mock_validate, mock_validate_in_share, mock_get_asset,
    mock_get_latest_media_file, mock_presign, mock_log_activity, client, mock_db,
):
    mock_validate.return_value = _share_link()
    asset = _share_asset()
    mock_get_asset.return_value = asset
    mock_get_latest_media_file.return_value = _media_file(duration_seconds=12.0)

    _share_stream(client, asset, "")

    assert mock_log_activity.call_args.kwargs["rendition"] is None


@patch("apps.api.routers.share._get_asset")
@patch("apps.api.routers.share.validate_share_link_with_session")
def test_the_share_list_is_rate_limited(mock_validate, mock_get_asset, client, mock_db):
    with patch("apps.api.middleware.rate_limit.check_rate_limit", return_value=(False, 10)):
        response = client.get(f"/share/some-token/downloads/{uuid.uuid4()}")

    assert response.status_code == 429
    mock_validate.assert_not_called()
