"""Two-pass video processing: the review never waits for 1080p, and a dropped DB connection
never throws a finished transcode away."""
import asyncio
import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from packages.transcoder.base import TranscodeJob, TranscodeResult
from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder

ASSET, VERSION, PROJECT = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
BASE = f"processed/{PROJECT}/{ASSET}/{VERSION}"


# ─── quick pass ──────────────────────────────────────────────────────────────

def _quick(height):
    from apps.api.tasks.transcode_tasks import _process_video
    result = TranscodeResult(success=True, hls_prefix=f"{BASE}/quick", height=height)
    with patch("packages.transcoder.ffmpeg_transcoder.FFmpegTranscoder") as MockT:
        MockT.return_value.transcode = AsyncMock(return_value=result)
        media_file = MagicMock(s3_key_raw="raw/x.mp4")
        upgrade = _process_video(MagicMock(), MagicMock(id=ASSET), MagicMock(id=VERSION), media_file, MagicMock(), BASE)
        job = MockT.return_value.transcode.call_args[0][0]
    return job, media_file, upgrade


def test_quick_pass_encodes_the_540p_proxy_and_360p_into_the_quick_prefix():
    """Every new version enqueues the 540p review proxy with its first pass."""
    job, media_file, _ = _quick(1080)
    assert job.qualities == ["540p", "360p"]
    assert job.output_s3_prefix == f"{BASE}/quick"
    assert job.make_thumbnail is True
    assert media_file.s3_key_processed == f"{BASE}/quick"


def test_upgrade_follows_only_when_the_ladder_would_hold_more_than_360p():
    assert _quick(2160)[2] is True
    assert _quick(1280)[2] is True    # portrait 720x1280 gets 1080p/720p renditions
    assert _quick(720)[2] is True
    assert _quick(480)[2] is False    # the ladder trims to 360p anyway
    assert _quick(None)[2] is False


# ─── process_asset ───────────────────────────────────────────────────────────

def _run_process_asset(process_video):
    from apps.api.models.asset import AssetType, ProcessingStatus
    from apps.api.tasks import transcode_tasks

    version = MagicMock(processing_status=None)
    asset = MagicMock(id=ASSET, project_id=PROJECT, asset_type=AssetType.video)
    db = MagicMock()
    db.query.return_value.filter.return_value.first.side_effect = [version, asset, MagicMock()]
    with patch.object(transcode_tasks, "SessionLocal", return_value=db), \
         patch.object(transcode_tasks, "get_s3_client"), \
         patch.object(transcode_tasks, "_process_video", side_effect=process_video), \
         patch.object(transcode_tasks, "_publish_event"), \
         patch("apps.api.services.automation_share.announce_asset_ready") as announce, \
         patch.object(transcode_tasks.upgrade_video_renditions, "delay") as delay, \
         patch.object(transcode_tasks.process_asset, "retry", side_effect=RuntimeError("retry")) as retry:
        try:
            transcode_tasks.process_asset.run(ASSET, VERSION)
        except RuntimeError:
            pass
    return version, db, announce, delay, retry, ProcessingStatus


def test_ready_and_announced_after_the_quick_pass_then_upgrade_queued():
    version, _, announce, delay, _, status = _run_process_asset(lambda *a: True)
    assert version.processing_status == status.ready
    announce.assert_called_once()
    delay.assert_called_once_with(ASSET, VERSION)


def test_no_upgrade_queued_for_a_small_source():
    _, _, _, delay, _, _ = _run_process_asset(lambda *a: False)
    delay.assert_not_called()


def test_a_failed_write_is_rolled_back_so_the_version_is_failed_and_retried():
    def boom(*a):
        raise RuntimeError("server closed the connection unexpectedly")
    version, db, _, delay, retry, status = _run_process_asset(boom)
    db.rollback.assert_called()
    assert version.processing_status == status.failed
    retry.assert_called_once()
    delay.assert_not_called()


# ─── upgrade_video_renditions ────────────────────────────────────────────────

def _run_upgrade(current_key, result, status=None, retries=0, key_after=None):
    from apps.api.models.asset import ProcessingStatus
    from apps.api.tasks import transcode_tasks

    version = MagicMock(processing_status=status or ProcessingStatus.ready)
    asset = MagicMock(project_id=PROJECT)
    media_file = MagicMock(s3_key_processed=current_key, s3_key_raw="raw/x.mp4")
    db = MagicMock()
    db.query.return_value.filter.return_value.first.side_effect = [version, asset, media_file]
    if key_after is not None:
        db.refresh.side_effect = lambda mf: setattr(mf, "s3_key_processed", key_after)
    task = transcode_tasks.upgrade_video_renditions
    with patch.object(transcode_tasks, "SessionLocal", return_value=db), \
         patch.object(transcode_tasks, "get_s3_client"), \
         patch("packages.transcoder.ffmpeg_transcoder.FFmpegTranscoder") as MockT, \
         patch.object(task, "retry", side_effect=RuntimeError("retry")) as retry:
        MockT.return_value.transcode = AsyncMock(return_value=result)
        task.push_request(retries=retries)
        try:
            task.run(ASSET, VERSION)
        except RuntimeError:
            pass
        finally:
            task.pop_request()
    job = MockT.return_value.transcode.call_args[0][0] if MockT.return_value.transcode.called else None
    return media_file, job, retry


def test_upgrade_builds_the_full_ladder_and_switches_playback():
    media_file, job, _ = _run_upgrade(f"{BASE}/quick", TranscodeResult(success=True, hls_prefix=BASE))
    assert job.qualities == ["1080p", "720p", "540p", "360p"]
    assert job.output_s3_prefix == BASE
    assert job.make_thumbnail is False
    assert media_file.s3_key_processed == BASE


def test_upgrade_skips_a_version_that_is_not_on_its_quick_copy():
    media_file, job, _ = _run_upgrade(BASE, TranscodeResult(success=True, hls_prefix=BASE))
    assert job is None and media_file.s3_key_processed == BASE


def test_upgrade_skips_a_version_that_is_not_ready():
    from apps.api.models.asset import ProcessingStatus
    _, job, _ = _run_upgrade(f"{BASE}/quick", TranscodeResult(success=True), status=ProcessingStatus.processing)
    assert job is None


def test_failed_upgrade_retries_once_then_stays_at_360p():
    failed = TranscodeResult(success=False, error="ffmpeg exited 1")
    media_file, _, retry = _run_upgrade(f"{BASE}/quick", failed, retries=0)
    retry.assert_called_once()
    media_file, _, retry = _run_upgrade(f"{BASE}/quick", failed, retries=1)
    retry.assert_not_called()
    assert media_file.s3_key_processed == f"{BASE}/quick"


def test_upgrade_does_not_overwrite_a_key_changed_during_the_encode():
    media_file, _, _ = _run_upgrade(f"{BASE}/quick", TranscodeResult(success=True, hls_prefix=BASE),
                                    key_after="processed/other")
    assert media_file.s3_key_processed == "processed/other"


# ─── transcoder: poster ──────────────────────────────────────────────────────

def _transcode(make_thumbnail):
    def run(cmd, **_kw):
        m = MagicMock(returncode=0, stderr="")
        if "-select_streams" in cmd:
            v = cmd[cmd.index("-select_streams") + 1] == "v:0"
            m.stdout = json.dumps({"streams": [{"r_frame_rate": "30/1", "duration": 6.0,
                                                "width": 1920, "height": 1080}] if v else []})
        return m
    with patch("subprocess.run", side_effect=run) as mock_run:
        s3 = MagicMock()
        s3.generate_presigned_url.return_value = "https://s3.example.com/raw.mp4"
        with patch("pathlib.Path.rglob", return_value=[]), patch("pathlib.Path.mkdir"), patch("shutil.rmtree"):
            asyncio.run(FFmpegTranscoder(s3, "bucket").transcode(TranscodeJob(
                media_id="m", version_id="v", input_s3_key="raw.mp4", output_s3_prefix="p",
                qualities=["360p"], make_thumbnail=make_thumbnail)))
    return [c for c in mock_run.call_args_list if "yuvj420p" in c[0][0]]


def test_poster_read_is_capped_and_reads_the_local_copy():
    (call,) = _transcode(True)
    cmd = call[0][0]
    assert call[1]["timeout"] == 600
    assert not cmd[cmd.index("-i") + 1].startswith("http")


def test_no_poster_when_the_job_says_so():
    assert _transcode(False) == []


# ─── database ────────────────────────────────────────────────────────────────

def test_pool_checks_a_connection_before_handing_it_out():
    from apps.api.database import engine
    assert engine.pool._pre_ping is True


# ─── transcoder: ai_proxy reads the playlist the muxer actually wrote ───────

def _remux_input(qualities, height=1080):
    def run(cmd, **_kw):
        m = MagicMock(returncode=0, stderr="")
        if "-select_streams" in cmd:
            v = cmd[cmd.index("-select_streams") + 1] == "v:0"
            m.stdout = json.dumps({"streams": [{"r_frame_rate": "30/1", "duration": 6.0,
                                                "width": height * 16 // 9, "height": height}] if v else []})
        return m
    with patch("subprocess.run", side_effect=run) as mock_run:
        s3 = MagicMock()
        s3.generate_presigned_url.return_value = "https://s3.example.com/raw.mp4"
        with patch("pathlib.Path.rglob", return_value=[]), patch("pathlib.Path.mkdir"), \
             patch("pathlib.Path.exists", return_value=True), patch("shutil.rmtree"):
            asyncio.run(FFmpegTranscoder(s3, "bucket").transcode(TranscodeJob(
                media_id="m", version_id="v", input_s3_key="raw.mp4", output_s3_prefix="p",
                qualities=qualities, make_thumbnail=False)))
    calls = [c[0][0] for c in mock_run.call_args_list]
    encode = next(c for c in calls if "-var_stream_map" in c)
    remux = next(c for c in calls if "+faststart" in c)
    return encode, remux[remux.index("-i") + 1]


def test_ai_proxy_remuxes_the_360p_variant_from_its_index_directory():
    # -var_stream_map makes the muxer write %v = 0, 1, 2 - the proxy must read that directory.
    encode, src = _remux_input(["1080p", "720p", "360p"])
    assert any("%v" in a for a in encode)
    assert src.endswith("/2/playlist.m3u8")
    _, src = _remux_input(["360p"])
    assert src.endswith("/0/playlist.m3u8")
