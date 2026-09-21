"""The budget has to reach an actual ffmpeg command, in the right position.

`parse_cpu_budget` and `thread_plan` can both be perfect and the feature still
dead, or worse, quietly dead. The position is not a detail here: a global
`-threads` before `-i` is an input option, it reaches the decoder, and the
encoders never see it. Measured on a 16-core host, three rungs, one run per
value -- 1, 2, 4, 6 and 8 all left occupancy at ~11 cores, exactly as if nothing
had been set. A limit that appears to work and does not is the worst outcome
this feature can have, so the placement is pinned, not just the presence.
"""
import asyncio
import json
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from apps.api.tests.test_source_copy import _transcode
from packages.transcoder.base import TranscodeJob
from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder


@pytest.fixture(autouse=True)
def _a_machine_of_a_known_size(monkeypatch):
    """Pin the core count so these tests mean the same thing everywhere.

    Without it they pass on a roomy workstation and fail on a small CI runner,
    for a reason that is the feature working: a budget at or above what is
    available deliberately resolves to unbounded, so `TRANSCODER_CPU_LIMIT=6`
    means "no limit" on a four-core box. Right behaviour, wrong thing for a test
    to depend on -- what is under test here is the arithmetic and the
    placement, not the size of the machine running pytest.
    """
    monkeypatch.setattr(
        "packages.transcoder.ffmpeg_transcoder.available_cpus", lambda: 16
    )


def _ffmpeg_cmd_for(qualities: list[str], source=(1920, 1080),
                    color_transfer: str | None = None,
                    backend: str | None = None) -> list[str]:
    """Run a transcode with everything mocked and return the ffmpeg command.

    `color_transfer="arib-std-b67"` makes the source HDR, which is what puts the
    tone-map chain into the filter graph -- the expensive part of the graph, and
    the one an ordinary phone clip goes through. `backend="nvenc"` forces a
    hardware attempt: the mocked `subprocess.run` reports success, so the first
    attempt is the only command built and there is no fallback to read past.
    """
    width, height = source

    def run(cmd, **_kwargs):
        mock = MagicMock()
        mock.returncode = 0
        mock.stderr = ""
        if "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "v:0":
            stream = {"r_frame_rate": "25/1", "duration": 6.0,
                      "width": width, "height": height}
            if color_transfer:
                stream["color_transfer"] = color_transfer
            mock.stdout = json.dumps({"streams": [stream]})
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
    backend_patch = (
        patch("packages.transcoder.ffmpeg_transcoder.get_backend",
              return_value=backend)
        if backend else nullcontext()
    )
    with patch("subprocess.run", side_effect=run) as mock_run, \
         patch("builtins.open", MagicMock()), \
         patch("pathlib.Path.glob", return_value=[]), \
         patch("pathlib.Path.rglob", return_value=[]), \
         patch("pathlib.Path.mkdir"), \
         patch("shutil.rmtree"), \
         backend_patch:
        asyncio.run(FFmpegTranscoder(s3, "test-bucket").transcode(job))
    calls = [c for c in mock_run.call_args_list
             if any("filter_complex" in str(a) for a in c[0][0])]
    assert calls, "no -filter_complex call was made"
    return calls[0][0][0]


def _threads_for(cmd: list[str]) -> dict[str, str]:
    """Every `-threads:v:i` in the command, by stream specifier."""
    return {
        token: cmd[i + 1]
        for i, token in enumerate(cmd)
        if token.startswith("-threads:v:")
    }


# --------------------------------------------------------- the unset case

def test_without_the_setting_the_command_is_unchanged(monkeypatch):
    # Every deployment that never touched this has to get byte-identical
    # arguments. No thread option of any kind may appear.
    monkeypatch.delenv("TRANSCODER_CPU_LIMIT", raising=False)
    cmd = _ffmpeg_cmd_for(["1080p", "720p", "360p"])

    assert not [t for t in cmd if "threads" in t]


# ------------------------------------------------------------ the placement

def test_the_budget_never_becomes_a_global_option(monkeypatch):
    # The mutation this exists for: "simplify" the per-stream options into one
    # global `-threads`. It parses, it runs, it reads like a limit -- and it
    # caps nothing, because before `-i` it is a decoder option.
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "6")
    cmd = _ffmpeg_cmd_for(["1080p", "720p", "360p"])

    assert "-threads" not in cmd, "a bare -threads reaches the decoder, not the encoders"

    input_at = cmd.index("-i")
    for i, token in enumerate(cmd):
        if token.startswith("-threads:v:"):
            assert i > input_at, f"{token} sits before -i and would be an input option"


# --------------------------------------------------------- the split itself

def test_the_budget_is_divided_across_the_rungs(monkeypatch):
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "6")
    cmd = _ffmpeg_cmd_for(["1080p", "720p", "360p"])

    assert _threads_for(cmd) == {
        "-threads:v:0": "2", "-threads:v:1": "2", "-threads:v:2": "2",
    }


def test_a_single_rung_receives_the_whole_budget(monkeypatch):
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "6")
    cmd = _ffmpeg_cmd_for(["720p"])

    assert _threads_for(cmd) == {"-threads:v:0": "6"}


def test_the_remainder_reaches_the_rung_it_was_given_to(monkeypatch):
    # Every other budget in this file divides evenly across its rungs, which
    # leaves the index that maps plan entry i to `-threads:v:i` unpinned:
    # collapsing it to `cpu_plan[0][0]` emits 9 encoder threads on a 7-core
    # budget and reddens nothing. The uneven case is the only one that can see
    # it, and the policy it checks is documented in `thread_plan` -- the
    # remainder goes to the earliest rungs, which are the largest.
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "7")
    cmd = _ffmpeg_cmd_for(["1080p", "720p", "360p"])

    assert _threads_for(cmd) == {
        "-threads:v:0": "3", "-threads:v:1": "2", "-threads:v:2": "2",
    }


def test_the_plan_is_sized_from_the_ladder_that_survives_pruning(monkeypatch):
    # The call site's one load-bearing assumption: rungs above the source are
    # dropped before `thread_plan` is asked how many there are. Sizing it from
    # the requested ladder instead -- `requested` is the other name in scope on
    # the same screen -- hands this upload 2 threads of the 6 it was granted,
    # on every source below the top rung, and every other test here uses a
    # 1080p source where the two lists are identical.
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "6")
    cmd = _ffmpeg_cmd_for(["1080p", "720p", "360p"], source=(640, 360))

    assert _threads_for(cmd) == {"-threads:v:0": "6"}


def test_a_share_is_resolved_against_what_is_available(monkeypatch):
    monkeypatch.setattr(
        "packages.transcoder.ffmpeg_transcoder.available_cpus", lambda: 16
    )
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "25%")
    cmd = _ffmpeg_cmd_for(["1080p", "720p"])

    # 25% of 16 is 4, two rungs, two each.
    assert _threads_for(cmd) == {"-threads:v:0": "2", "-threads:v:1": "2"}


def test_every_rung_keeps_a_thread_when_the_budget_is_smaller(monkeypatch):
    # A rung with zero threads is not a slower rung, it is an unbounded one:
    # ffmpeg reads a zero thread count as "pick for yourself".
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "2")
    cmd = _ffmpeg_cmd_for(["1080p", "720p", "360p"])

    assert _threads_for(cmd) == {
        "-threads:v:0": "1", "-threads:v:1": "1", "-threads:v:2": "1",
    }


# --------------------------------------------------------- the filter graph

def test_the_filter_graph_is_bounded_too(monkeypatch):
    # Leaving the graph out would put back the one unbounded pool this setting
    # exists to remove: unset, it went to 9-11 cores on a 4K source.
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "6")
    cmd = _ffmpeg_cmd_for(["1080p", "720p", "360p"])

    assert "-filter_complex_threads" in cmd


def test_the_filter_graph_gets_half_the_budget(monkeypatch):
    # Not one thread, which is what this was until a 4K source was measured
    # rather than a 1080p one. At one thread the graph becomes the bottleneck
    # and the job takes 1.65 of the six cores it was granted; at half the budget
    # it takes 3.68 and finishes in half the time. The whole budget is faster
    # again and overruns the cap on every 4K source tried, so half is the share
    # that is both useful and honest.
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "6")
    cmd = _ffmpeg_cmd_for(["1080p", "720p", "360p"])

    assert cmd[cmd.index("-filter_complex_threads") + 1] == "3"


def test_a_budget_of_one_still_leaves_the_graph_a_thread(monkeypatch):
    # budget // 2 is 0 here, and a filter graph with zero threads is not a
    # slower graph, it is the unbounded graph: ffmpeg accepts
    # `-filter_complex_threads 0` and reads it as "pick for yourself". So the
    # smallest budget an operator can set is the one that would cap least.
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "1")
    cmd = _ffmpeg_cmd_for(["720p"])

    assert cmd[cmd.index("-filter_complex_threads") + 1] == "1"


# ------------------------------------------------------- the hardware backends

def test_a_hardware_backend_still_bounds_the_filter_graph(monkeypatch):
    # The gap this closes: -threads:v:i is emitted only for software encoders,
    # so before the graph scaled with the budget, TRANSCODER_CPU_LIMIT=2 and
    # =14 built byte-identical commands on nvenc and the operator's number was
    # discarded. On a hardware backend the filter graph is the CPU work there
    # is -- an HDR source tone-maps through hwdownload, zscale, tonemap,
    # hwupload -- so it is the one thing worth capping.
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "8")
    cmd = _ffmpeg_cmd_for(["1080p", "720p", "360p"],
                          color_transfer="arib-std-b67", backend="nvenc")

    assert cmd[cmd.index("-filter_complex_threads") + 1] == "4"


def test_a_hardware_backend_gets_no_encoder_thread_counts(monkeypatch):
    # The hardware encoders take their thread counts from the driver. A count
    # here would either be ignored or throttle the part that is not the
    # bottleneck, so the budget must not reach them.
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "8")
    cmd = _ffmpeg_cmd_for(["1080p", "720p", "360p"],
                          color_transfer="arib-std-b67", backend="nvenc")

    assert _threads_for(cmd) == {}
    assert "-threads" not in cmd


def test_the_budget_reaches_a_hardware_command_at_all(monkeypatch):
    # The regression that started this: two different budgets producing the
    # same command. Nothing pinned it, and both a fix and its absence stayed
    # green.
    #
    # Compare the one token the budget can reach, not the two whole commands.
    # Each _ffmpeg_cmd_for call makes its own tempfile.mkdtemp work dir, and
    # that path lands in -hls_segment_filename and the playlist argument, so
    # `klein != gross` is true for any two invocations whatever the budget
    # does: it stayed green with `return per_rung, 1` restored and with the
    # -filter_complex_threads emission deleted outright.
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "2")
    klein = _ffmpeg_cmd_for(["1080p", "720p", "360p"],
                            color_transfer="arib-std-b67", backend="nvenc")
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "14")
    gross = _ffmpeg_cmd_for(["1080p", "720p", "360p"],
                            color_transfer="arib-std-b67", backend="nvenc")

    assert "-filter_complex_threads" in klein, "the budget reaches no option at all"
    assert (klein[klein.index("-filter_complex_threads") + 1]
            != gross[gross.index("-filter_complex_threads") + 1]), \
        "the operator's number changes nothing on nvenc"


# ------------------------------------------------------- the stream-copy path

def test_a_stream_copy_gets_no_thread_arguments(monkeypatch):
    # A copy has no encoder and no filter graph, so there is nothing to bound.
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "2")
    cmd, result, _ = _transcode(["1080p"], source=(1920, 1080))

    assert result.success
    assert not [t for t in cmd if "threads" in t]


def test_a_stream_copy_cannot_be_short_of_threads(monkeypatch, capsys):
    # Worth pinning because it is the reason the plan can be computed before the
    # path is chosen: a copy only happens once the ladder has resolved to a
    # single rung, and one rung is never short.
    #
    # Silence only means something if the warning is live at this budget, so the
    # encode that does warn is asserted first -- without it, deleting the
    # shortfall report entirely left this test green. And it is NOT the guard
    # against the copy gate widening to a real ladder: the gate is what decides
    # the rung count this test sees, so it cannot reach that mutation.
    # `test_source_copy.py::test_a_configured_ladder_still_gets_every_rung_it_asked_for`
    # is the one that catches it.
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "1")
    capsys.readouterr()

    _transcode(["1080p", "720p", "360p"], source=(1920, 1080))
    assert "need one thread each" in capsys.readouterr().out

    cmd, result, _ = _transcode(["1080p"], source=(1920, 1080))

    assert result.success
    assert "need one thread each" not in capsys.readouterr().out


def test_a_copy_that_falls_back_to_encoding_still_gets_the_budget(monkeypatch):
    # The reason the plan cannot simply be skipped for a copy job: a refused or
    # failed copy falls back to a real encode, and that encode has to be capped
    # like any other. Keyframes 20s apart are refused for a copy.
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "6")
    cmd, result, _ = _transcode(["1080p"], source=(1920, 1080),
                                keyframes=[0.0, 20.0])

    assert result.success
    assert _threads_for(cmd) == {"-threads:v:0": "6"}


def test_a_broken_value_leaves_the_command_alone(monkeypatch):
    # The setting gets written when the machine is already struggling. A typo
    # must cost a line in the log, not every upload -- the same failure shape
    # #325 had to fix once for the ladder itself.
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "half")
    cmd = _ffmpeg_cmd_for(["1080p", "720p", "360p"])

    assert not [t for t in cmd if "threads" in t]
    assert "-filter_complex" in cmd  # and it still built a real command
