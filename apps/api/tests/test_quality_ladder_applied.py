"""The setting has to reach an actual ffmpeg command, not just parse cleanly.

`parse_qualities` can be perfect and the feature still dead: what makes the
ladder configurable is the call site in `transcode_tasks` reading the setting,
and the filter graph in the transcoder building what the job asks for. Both are
pinned here, in the two places a mistake would be silent -- the job that gets
built, and the `-filter_complex` that comes out.
"""
import asyncio
import json
import re
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from apps.api.models.asset import AssetType
from apps.api.tasks import transcode_tasks
from packages.transcoder.base import TranscodeJob, TranscodeResult
from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder


# ─────────────────────────────────── the setting reaching the job

@contextmanager
def _capture_job(result: TranscodeResult):
    """Run `_process_video` against a stubbed transcoder and hand back the job.

    Patching only `_run_async` leaves the real coroutine constructed and never
    awaited, so the class is stubbed with it (see test_audio_only_reroute).
    """
    with patch("packages.transcoder.ffmpeg_transcoder.FFmpegTranscoder") as cls, \
         patch.object(transcode_tasks, "_run_async", MagicMock(return_value=result)):
        cls.return_value.transcode.return_value = None
        yield cls


def _fixtures():
    asset = SimpleNamespace(id="asset-1", project_id="proj-1", asset_type=AssetType.video)
    version = SimpleNamespace(id="ver-1")
    media_file = SimpleNamespace(
        s3_key_raw="raw/clip.mp4", s3_key_processed=None,
        s3_key_thumbnail=None, duration_seconds=None,
    )
    return asset, version, media_file, MagicMock()


def _job_for(configured: str) -> TranscodeJob:
    asset, version, media_file, db = _fixtures()
    result = TranscodeResult(
        success=True, hls_prefix="processed/x",
        duration_seconds=6.0, width=1920, height=1080, fps=25.0,
    )
    with patch.object(transcode_tasks.settings, "transcoder_qualities", configured), \
         _capture_job(result) as cls:
        transcode_tasks._process_video(db, asset, version, media_file, MagicMock(), "processed/x")
    return cls.return_value.transcode.call_args[0][0]


def test_the_job_carries_the_configured_ladder_and_not_a_literal():
    # The mutation this exists for: put the old hardcoded list back at the call
    # site and every test about parsing still passes.
    assert _job_for("720p").qualities == ["720p"]
    assert _job_for("1080p,360p").qualities == ["1080p", "360p"]


def test_an_unset_or_broken_setting_still_yields_the_full_ladder():
    # A typo must cost a warning, not every upload on the instance.
    assert _job_for("").qualities == ["1080p", "720p", "360p"]
    assert _job_for("108p,72p").qualities == ["1080p", "720p", "360p"]


# ─────────────────────────────────── the job reaching the filter graph

def _ffmpeg_cmd_for(qualities: list[str], source: tuple[int, int],
                    stream: dict | None = None) -> list[str]:
    """Run a transcode with everything mocked and return the ffmpeg command."""
    width, height = source

    def run(cmd, **_kwargs):
        mock = MagicMock()
        mock.returncode = 0
        mock.stderr = ""
        if "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "V:0":
            mock.stdout = json.dumps({"streams": [
                {"r_frame_rate": "25/1", "duration": 6.0, "width": width, "height": height,
                 **(stream or {})},
            ]})
        elif "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "a":
            mock.stdout = json.dumps({"streams": []})
        return mock

    job = TranscodeJob(
        media_id="media-1", version_id="v1",
        input_s3_key="uploads/video.mp4", output_s3_prefix="hls/media-1/v1",
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
        asyncio.run(FFmpegTranscoder(s3, "test-bucket").transcode(job))
    calls = [c for c in mock_run.call_args_list
             if any("filter_complex" in str(a) for a in c[0][0])]
    assert calls, "no -filter_complex call was made"
    return calls[0][0][0]


def _filter_complex(cmd: list[str]) -> str:
    return cmd[cmd.index("-filter_complex") + 1]


def _boxes(cmd: list[str]) -> dict[str, str]:
    """Each rung's scale box, by rung name."""
    return dict((q, box) for box, q in
                re.findall(r"scale(?:_\w+)?=(\d+:\d+):[^\[]*\[(\w+)\]", _filter_complex(cmd)))


def test_one_configured_rung_builds_exactly_one_rendition():
    cmd = _ffmpeg_cmd_for(["720p"], source=(1920, 1080))
    graph = _filter_complex(cmd)

    assert "split=1" in graph
    assert "scale=1280:720" in graph
    assert "1920:1080" not in graph
    # and the manifest has one variant to match
    assert cmd[cmd.index("-var_stream_map") + 1] == "v:0"
    assert cmd.count("-map") == 1


def test_the_default_ladder_still_builds_three():
    graph = _filter_complex(_ffmpeg_cmd_for(["1080p", "720p", "360p"], source=(1920, 1080)))

    assert "split=3" in graph
    for spec in ("scale=1920:1080", "scale=1280:720", "scale=640:360"):
        assert spec in graph


def test_a_rung_above_the_source_is_built_at_the_source_size():
    # `TRANSCODER_QUALITIES=1080p` on a small source used to produce one
    # upscaled 1920x1080 rendition: more encode time and more storage than the
    # source itself, which is the opposite of what the setting is for.
    graph = _filter_complex(_ffmpeg_cmd_for(["1080p"], source=(640, 360)))

    assert "split=1" in graph
    assert "scale=640:360" in graph
    assert "1920:1080" not in graph


def test_rungs_below_the_source_are_untouched_by_the_clamp():
    graph = _filter_complex(_ffmpeg_cmd_for(["720p", "360p"], source=(1920, 1080)))

    assert "scale=1280:720" in graph
    assert "scale=640:360" in graph


def test_junk_reaching_the_transcoder_still_produces_a_ladder():
    # A TranscodeJob can be built by any caller and `qualities` is a plain list,
    # so the guard at the filtering site is what stops `split=0` and the empty
    # `-var_stream_map` that ffmpeg rejects.
    graph = _filter_complex(_ffmpeg_cmd_for(["4320p"], source=(1920, 1080)))

    assert "split=3" in graph
    assert "split=0" not in graph


# ─────────────────────────────────── 2160p, alone, means "source size"

def test_2160p_alone_builds_one_rendition_at_the_source_s_size():
    # The table #451 asked for. Every source up to 4K keeps its own size, and
    # nothing is upscaled to 3840x2160 on the way.
    for width, height in ((1280, 720), (1920, 1080), (2560, 1440), (3840, 2160)):
        graph = _filter_complex(_ffmpeg_cmd_for(["2160p"], source=(width, height)))
        assert "split=1" in graph
        assert f"scale={width}:{height}:" in graph, f"{width}x{height}"


def test_a_source_larger_than_4k_is_fitted_into_2160p():
    graph = _filter_complex(_ffmpeg_cmd_for(["2160p"], source=(7680, 4320)))

    assert "split=1" in graph
    assert "scale=3840:2160:" in graph


def test_2160p_on_top_of_the_default_ladder_builds_four():
    cmd = _ffmpeg_cmd_for(["2160p", "1080p", "720p", "360p"], source=(3840, 2160))
    graph = _filter_complex(cmd)

    assert "split=4" in graph
    for spec in ("scale=3840:2160", "scale=1920:1080", "scale=1280:720", "scale=640:360"):
        assert spec in graph
    assert cmd[cmd.index("-var_stream_map") + 1].split() == ["v:0", "v:1", "v:2", "v:3"]


# ─────────────────────────────────── portrait sources, by their short side

ROTATED_90 = {"side_data_list": [{"side_data_type": "Display Matrix", "rotation": -90}]}


def test_a_portrait_source_gets_portrait_rungs_at_its_own_width():
    # Every box used to be landscape, so the "1080p" rendition of a 1080x1920
    # phone clip was 608x1080 and nothing played at the source's size (#452).
    cmd = _ffmpeg_cmd_for(["1080p", "720p", "360p"], source=(1080, 1920))

    assert _boxes(cmd) == {"1080p": "1080:1920", "720p": "720:1280", "360p": "360:640"}


def test_a_portrait_rung_is_kept_by_the_short_side():
    # 1080 <= 1280 kept the 1080p rung for a 720x1280 clip, which then came out
    # 608x1080: smaller than the source and named for a size it never had.
    cmd = _ffmpeg_cmd_for(["1080p", "720p", "360p"], source=(720, 1280))

    assert _boxes(cmd) == {"720p": "720:1280", "360p": "360:640"}


def test_a_rotated_landscape_file_gets_the_same_rungs_as_a_portrait_one():
    # Stored 1920x1080 with a 90-degree matrix: ffmpeg turns the frame upright
    # before the graph, so the scaler is handed 1080x1920.
    rotated = _ffmpeg_cmd_for(["1080p", "720p", "360p"], source=(1920, 1080), stream=ROTATED_90)

    assert _boxes(rotated) == {"1080p": "1080:1920", "720p": "720:1280", "360p": "360:640"}


def test_2160p_on_a_portrait_4k_source_keeps_its_size():
    cmd = _ffmpeg_cmd_for(["2160p"], source=(2160, 3840))

    assert _boxes(cmd) == {"2160p": "2160:3840"}


def test_a_small_rotated_source_is_clamped_to_its_upright_size():
    # The clamp names the source's size, and the scaler is handed it upright.
    cmd = _ffmpeg_cmd_for(["1080p"], source=(480, 270), stream=ROTATED_90)

    assert _boxes(cmd) == {"1080p": "270:480"}


def test_landscape_and_square_sources_keep_the_boxes_they_had():
    for source in ((1920, 1080), (1440, 1080), (1080, 1080)):
        cmd = _ffmpeg_cmd_for(["1080p", "720p", "360p"], source=source)
        assert _boxes(cmd) == {"1080p": "1920:1080", "720p": "1280:720", "360p": "640:360"}, source
