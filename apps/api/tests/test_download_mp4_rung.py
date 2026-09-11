"""A video has to have one file someone can actually download.

The ladder is HLS, so "Download" had only the raw upload to offer: the camera
master, which can be an order of magnitude larger than the rendition the
reviewer watched. The transcode now remuxes the top rung's segments into a
single MP4 with `-c copy`, and the download path serves that.

Every step between the two is pinned here, because each one is silent when it
breaks: the remux command ffmpeg is given, the key reaching the version row, the
key the endpoints choose, and the fallback that keeps every video uploaded
before this rung existed downloadable.
"""
import asyncio
import json
import uuid
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from apps.api.models.asset import AssetType
from apps.api.tasks import transcode_tasks
from packages.transcoder.base import TranscodeJob, TranscodeResult
from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder


# ─────────────────────────────────── the remux ffmpeg is asked to do

def _run_transcode(qualities: list[str], source=(1920, 1080), remux_fails=False):
    """Run a transcode with ffmpeg and S3 mocked out.

    Returns (result, ffmpeg commands, s3 mock). Same shape as the ladder tests
    in test_quality_ladder_applied: subprocess is stubbed, the HLS upload walk
    finds no files, and the thumbnail is never written.
    """
    width, height = source

    def run(cmd, **_kwargs):
        mock = MagicMock()
        mock.returncode = 0
        mock.stderr = ""
        if "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "v:0":
            mock.stdout = json.dumps({"streams": [
                {"r_frame_rate": "25/1", "duration": 6.0, "width": width, "height": height},
            ]})
        elif "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "a":
            mock.stdout = json.dumps({"streams": [{"codec_name": "aac"}]})
        if remux_fails and any(str(a).endswith("download.mp4") for a in cmd):
            mock.returncode = 1
            mock.stderr = "Invalid data found when processing input"
        return mock

    job = TranscodeJob(
        media_id="media-1", version_id="v1",
        input_s3_key="uploads/video.mp4", output_s3_prefix="processed/p/a/v",
        qualities=qualities,
    )
    s3 = MagicMock()
    s3.generate_presigned_url.return_value = "https://s3.example.com/uploads/video.mp4"
    with patch("subprocess.run", side_effect=run) as mock_run, \
         patch("builtins.open", MagicMock()), \
         patch("pathlib.Path.glob", return_value=[]), \
         patch("pathlib.Path.rglob", return_value=[]), \
         patch("pathlib.Path.mkdir"), \
         patch("shutil.rmtree"):
        result = asyncio.run(FFmpegTranscoder(s3, "test-bucket").transcode(job))
    cmds = [c[0][0] for c in mock_run.call_args_list]
    return result, cmds, s3


def _remux_cmd(cmds: list[list[str]]) -> list[str]:
    found = [c for c in cmds if any(str(a).endswith("download.mp4") for a in c)]
    assert len(found) == 1, f"expected exactly one remux command, got {len(found)}"
    return found[0]


def test_the_download_rung_is_a_stream_copy_of_a_rendition():
    result, cmds, s3 = _run_transcode(["1080p", "720p", "360p"])
    cmd = _remux_cmd(cmds)

    # A copy, not an encode: this must never cost a second pass over the video.
    assert cmd[cmd.index("-c") + 1] == "copy"
    assert "-movflags" in cmd and cmd[cmd.index("-movflags") + 1] == "+faststart"
    # AAC in MPEG-TS is ADTS-framed; MP4 wants the bare stream.
    assert cmd[cmd.index("-bsf:a") + 1] == "aac_adtstoasc"
    # Its input is a rendition we just wrote, not the source.
    assert cmd[cmd.index("-i") + 1].endswith("/playlist.m3u8")
    assert "https://s3.example.com/uploads/video.mp4" not in cmd

    assert result.success
    assert result.mp4_key == "processed/p/a/v/download.mp4"
    key, extra = _uploaded_mp4(s3)
    assert key == "processed/p/a/v/download.mp4"
    assert extra["ContentType"] == "video/mp4"


def _uploaded_mp4(s3) -> tuple[str, dict]:
    calls = [c for c in s3.upload_file.call_args_list if str(c[0][2]).endswith(".mp4")]
    assert len(calls) == 1, f"expected one MP4 upload, got {len(calls)}"
    return calls[0][0][2], calls[0].kwargs["ExtraArgs"]


def test_the_rung_remuxed_is_the_tallest_one_built():
    # `-var_stream_map` has no `name:` field, so variant i lands in a directory
    # named i, in the order the rungs were mapped -- which is the order the job
    # asked for them, not descending height. Taking directory 0 would hand a
    # reviewer the 360p here.
    _, cmds, _ = _run_transcode(["360p", "1080p"])
    cmd = _remux_cmd(cmds)
    assert cmd[cmd.index("-i") + 1].endswith("/1/playlist.m3u8")

    _, cmds, _ = _run_transcode(["1080p", "360p"])
    cmd = _remux_cmd(cmds)
    assert cmd[cmd.index("-i") + 1].endswith("/0/playlist.m3u8")


def test_a_failed_remux_does_not_fail_a_good_ladder():
    # The ladder is the product. A video that plays but has no download rung is
    # a working asset; a failed transcode is not.
    result, _, _ = _run_transcode(["1080p"], remux_fails=True)

    assert result.success is True
    assert result.hls_prefix == "processed/p/a/v"
    assert result.mp4_key is None


# ─────────────────────────────────── the key reaching the row

@contextmanager
def _stubbed_transcoder(result: TranscodeResult):
    with patch("packages.transcoder.ffmpeg_transcoder.FFmpegTranscoder") as cls, \
         patch.object(transcode_tasks, "_run_async", MagicMock(return_value=result)):
        cls.return_value.transcode.return_value = None
        yield cls


def _process_video_with(result: TranscodeResult):
    asset = SimpleNamespace(id="asset-1", project_id="proj-1", asset_type=AssetType.video)
    version = SimpleNamespace(id="ver-1")
    media_file = SimpleNamespace(
        s3_key_raw="raw/clip.mp4", s3_key_processed=None, s3_key_download=None,
        s3_key_thumbnail=None, duration_seconds=None,
    )
    with _stubbed_transcoder(result):
        transcode_tasks._process_video(
            MagicMock(), asset, version, media_file, MagicMock(), "processed/p/a/v"
        )
    return media_file


def test_the_version_row_records_the_download_rung():
    media_file = _process_video_with(TranscodeResult(
        success=True, hls_prefix="processed/p/a/v",
        mp4_key="processed/p/a/v/download.mp4",
    ))
    assert media_file.s3_key_download == "processed/p/a/v/download.mp4"


def test_a_transcode_without_one_leaves_the_column_null():
    media_file = _process_video_with(TranscodeResult(
        success=True, hls_prefix="processed/p/a/v", mp4_key=None,
    ))
    assert media_file.s3_key_download is None


# ─────────────────────────────────── the key the download serves

def _video_asset(mock_db, download_key):
    from apps.api.models.asset import ProcessingStatus

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

    media_file = MagicMock()
    media_file.version_id = version.id
    media_file.s3_key_processed = "processed/p/a/v"
    media_file.s3_key_raw = "raw/p/a/v/original.mov"
    media_file.s3_key_download = download_key
    media_file.s3_key_thumbnail = None
    media_file.original_filename = "Hero Spot.mov"

    mock_db.first.side_effect = [asset, version, media_file]
    return asset


@patch("apps.api.routers.assets.generate_presigned_get_url")
@patch("apps.api.routers.assets.require_asset_access")
def test_a_video_download_serves_the_mp4_rung_not_the_master(
    mock_require_access, mock_presign, client, mock_db, auth_headers,
):
    asset = _video_asset(mock_db, "processed/p/a/v/download.mp4")
    mock_require_access.return_value = None
    mock_presign.return_value = "https://s3.example.com/download.mp4?sig=x"

    response = client.get(
        f"/assets/{asset.id}/stream?download=true", headers=auth_headers
    )

    assert response.status_code == 200, response.text
    assert mock_presign.call_args[0][0] == "processed/p/a/v/download.mp4"
    # ...and the name follows those bytes, not the ProRes the editor uploaded.
    assert mock_presign.call_args.kwargs["download_filename"] == "Hero Spot.mp4"


@patch("apps.api.routers.assets.generate_presigned_get_url")
@patch("apps.api.routers.assets.require_asset_access")
def test_a_video_transcoded_before_the_rung_existed_still_downloads(
    mock_require_access, mock_presign, client, mock_db, auth_headers,
):
    # Every video already on an instance has a NULL column here, and no
    # backfill is coming, so this is the normal case for a long time.
    asset = _video_asset(mock_db, None)
    mock_require_access.return_value = None
    mock_presign.return_value = "https://s3.example.com/original.mov?sig=x"

    response = client.get(
        f"/assets/{asset.id}/stream?download=true", headers=auth_headers
    )

    assert response.status_code == 200, response.text
    assert mock_presign.call_args[0][0] == "raw/p/a/v/original.mov"
    assert mock_presign.call_args.kwargs["download_filename"] == "Hero Spot.mov"


@patch("apps.api.routers.assets.require_asset_access")
def test_watching_a_video_is_untouched_by_any_of_this(
    mock_require_access, client, mock_db, auth_headers,
):
    # The download rung must not become something the player reaches for: it is
    # one file, and playback is the whole reason the ladder exists.
    asset = _video_asset(mock_db, "processed/p/a/v/download.mp4")
    mock_require_access.return_value = None

    response = client.get(f"/assets/{asset.id}/stream", headers=auth_headers)

    assert response.status_code == 200, response.text
    assert response.json()["url"].startswith("/stream/hls/master.m3u8?token=")


@patch("apps.api.routers.share._log_share_activity")
@patch("apps.api.routers.share.generate_presigned_get_url")
@patch("apps.api.routers.share._get_latest_media_file")
@patch("apps.api.routers.share._get_asset")
@patch("apps.api.routers.share.validate_asset_in_share")
@patch("apps.api.routers.share.validate_share_link_with_session")
def test_a_share_link_download_serves_the_mp4_rung_too(
    mock_validate, mock_validate_in_share, mock_get_asset,
    mock_get_latest_media_file, mock_presign, mock_log_activity,
    client, mock_db,
):
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
    asset.name = "Hero Spot"
    asset.asset_type = AssetType.video
    asset.project_id = uuid.uuid4()
    mock_get_asset.return_value = asset

    media_file = MagicMock()
    media_file.version_id = uuid.uuid4()
    media_file.s3_key_processed = "processed/p/a/v"
    media_file.s3_key_raw = "raw/p/a/v/original.mov"
    media_file.s3_key_download = "processed/p/a/v/download.mp4"
    media_file.s3_key_thumbnail = None
    media_file.original_filename = "Hero Spot.mov"
    media_file.duration_seconds = 12.0
    mock_get_latest_media_file.return_value = media_file
    mock_presign.return_value = "https://s3.example.com/download.mp4?sig=x"

    response = client.get(f"/share/some-token/stream/{asset_id}?download=true")

    assert response.status_code == 200, response.text
    assert mock_presign.call_args_list[0][0][0] == "processed/p/a/v/download.mp4"
