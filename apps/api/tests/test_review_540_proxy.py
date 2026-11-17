"""The 540p review proxy: rung settings, the share stream's proxy_url, and the backfill task."""
import asyncio
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from packages.transcoder.base import TranscodeResult
from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder

from .test_ffmpeg_transcoder import _get_ffmpeg_cmd, _make_job, _mock_probe_side_effect


def _encode(width, height, qualities):
    with patch("subprocess.run", side_effect=_mock_probe_side_effect(width, height)) as mock_run:
        s3 = MagicMock()
        with patch("builtins.open", MagicMock()), patch("pathlib.Path.glob", return_value=[]), \
             patch("pathlib.Path.rglob", return_value=[]), patch("pathlib.Path.mkdir"), patch("shutil.rmtree"):
            asyncio.run(FFmpegTranscoder(s3, "b").transcode(_make_job(qualities)))
        return _get_ffmpeg_cmd(mock_run), mock_run


def test_540p_rung_is_capped_and_keyframed_every_second():
    cmd, _ = _encode(720, 1280, ["1080p", "720p", "540p", "360p"])
    i = 2  # third rung
    assert cmd[cmd.index(f"-maxrate:v:{i}") + 1] == "2000k"
    assert cmd[cmd.index(f"-bufsize:v:{i}") + 1] == "4000k"
    assert cmd[cmd.index(f"-force_key_frames:v:{i}") + 1] == "expr:gte(t,n_forced*1)"
    assert f"-g:v:{i}" in cmd and f"-sc_threshold:v:{i}" in cmd
    assert cmd[cmd.index(f"-b:a:{i}") + 1] == "128k"


def test_540p_is_sized_by_its_short_side_so_vertical_ads_stay_sharp():
    cmd, _ = _encode(720, 1280, ["540p"])
    fc = cmd[cmd.index("-filter_complex") + 1]
    assert "if(gt(iw,ih),-2,540)" in fc and "if(gt(iw,ih),540,-2)" in fc


def test_540p_is_dropped_for_a_source_with_a_short_side_below_540():
    cmd, _ = _encode(480, 854, ["540p", "360p"])
    fc = cmd[cmd.index("-filter_complex") + 1]
    assert "540" not in fc and "split=1" in fc


def test_540p_rung_also_becomes_a_progressive_review_mp4():
    _, mock_run = _encode(720, 1280, ["540p", "360p"])
    remuxes = [c.args[0] for c in mock_run.call_args_list
               if c.args and c.args[0][:1] == ["ffmpeg"] and "-movflags" in c.args[0]]
    assert any(r[-1].endswith("review_540.mp4") and "0/playlist.m3u8" in r[r.index("-i") + 1] for r in remuxes)


# --- share stream: proxy_url -------------------------------------------------

def _stream(proxy_exists):
    from apps.api.models.asset import AssetType
    from apps.api.routers import share
    media = MagicMock(s3_key_processed="processed/p/a/v", s3_key_raw="raw/x.mp4", s3_key_thumbnail=None, version_id=uuid.uuid4())
    with patch.object(share, "validate_share_link_with_session", return_value=MagicMock(allow_download=False)), \
         patch.object(share, "_get_asset", return_value=MagicMock(asset_type=AssetType.video, id=uuid.uuid4())), \
         patch.object(share, "validate_asset_in_share"), \
         patch.object(share, "_get_latest_media_file", return_value=media), \
         patch.object(share, "object_exists", return_value=proxy_exists) as exists, \
         patch.object(share, "generate_presigned_get_url", side_effect=lambda k, **kw: f"https://s3/{k}"), \
         patch.object(share, "_log_share_activity"), \
         patch("apps.api.services.review_timing.private_timing_context", return_value={}):
        out = share.get_share_stream_url("tok", uuid.uuid4(), None, None, False, None, MagicMock(), None)
    return out, exists


def test_share_stream_offers_the_540p_proxy_when_it_exists():
    out, exists = _stream(True)
    assert out["proxy_url"] == "https://s3/processed/p/a/v/review_540.mp4"
    assert out["url"].startswith("/stream/hls/master.m3u8?token=")   # HLS stays as the fallback
    exists.assert_called_with("processed/p/a/v/review_540.mp4")


def test_share_stream_has_no_proxy_url_while_the_proxy_is_missing():
    out, _ = _stream(False)
    assert out["proxy_url"] is None
    assert out["url"].startswith("/stream/hls/master.m3u8?token=")


# --- backfill task -----------------------------------------------------------

def _backfill(*, exists=False, width=720, height=1280, status="ready"):
    from apps.api.models.asset import AssetType, ProcessingStatus
    from apps.api.tasks import transcode_tasks as t
    a, v = str(uuid.uuid4()), str(uuid.uuid4())
    version = MagicMock(processing_status=ProcessingStatus.ready if status == "ready" else ProcessingStatus.processing)
    asset = MagicMock(project_id="proj", asset_type=AssetType.video)
    media = MagicMock(s3_key_processed="processed/proj/a/v", s3_key_raw="raw/x.mp4", width=width, height=height)
    db = MagicMock()
    db.query.return_value.filter.return_value.first.side_effect = [version, asset, media]
    s3 = MagicMock()
    with patch.object(t, "SessionLocal", return_value=db), patch.object(t, "get_s3_client", return_value=s3), \
         patch("apps.api.services.s3_service.object_exists", return_value=exists), \
         patch("packages.transcoder.ffmpeg_transcoder.FFmpegTranscoder") as T:
        T.return_value.transcode = AsyncMock(return_value=TranscodeResult(success=True))
        t.build_review_proxy.run(a, v)
        return T.return_value.transcode, s3


def test_backfill_encodes_540p_aside_and_copies_it_next_to_the_live_ladder():
    transcode, s3 = _backfill()
    job = transcode.call_args[0][0]
    assert job.qualities == ["540p"] and job.output_s3_prefix.endswith("/p540")
    assert s3.copy_object.call_args.kwargs["Key"] == "processed/proj/a/v/review_540.mp4"


def test_backfill_skips_existing_proxy_small_sources_and_unready_versions():
    assert _backfill(exists=True)[0].call_count == 0
    assert _backfill(width=406, height=720)[0].call_count == 0
    assert _backfill(status="processing")[0].call_count == 0
