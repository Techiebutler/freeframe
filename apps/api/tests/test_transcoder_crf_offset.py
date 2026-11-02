"""The quality shift has to reach an actual ffmpeg command, on every backend.

`parse_crf_offset` can be perfect and the feature still dead, or worse quietly
dead. Each backend spells its quality target differently -- CRF on libx264 and
libx265, `-global_quality` on QSV and VAAPI, `-qp` on NVENC -- so each one is a
separate place the shift has to land, and it has to land on a token that still
carries its stream specifier, or the last rung's value wins for the whole
ladder.
"""
import pytest

from apps.api.tests.test_source_copy import _transcode
from apps.api.tests.test_transcoder_cpu_budget_applied import _ffmpeg_cmd_for
from packages.transcoder.base import (
    COMPRESSION_LEVELS, DEFAULT_COMPRESSION_LEVEL,
    crf_offset_for_level, level_for_crf_offset,
)
from packages.transcoder.ffmpeg_transcoder import (
    QUALITY_MAP, job_crf_offset, parse_crf_offset, shift_quality,
)

LADDER = ["1080p", "720p", "360p"]
# What the 8-bit default path encodes at today: QUALITY_MAP plus four.
BASELINE_8BIT = {q: QUALITY_MAP[q][1] + 4 for q in LADDER}


@pytest.fixture(autouse=True)
def _no_inherited_offset(monkeypatch):
    """A value in the ambient environment must not decide what these assert."""
    monkeypatch.delenv("TRANSCODER_CRF_OFFSET", raising=False)


def _values_for(cmd: list[str], option: str) -> dict[str, str]:
    """Every `{option}...` token in `cmd`, mapped to the value that follows it."""
    return {t: cmd[i + 1] for i, t in enumerate(cmd) if t.split(":")[0] == option}


@pytest.mark.parametrize("raw,expected,logged", [
    (None, 0, False), ("", 0, False), ("0", 0, False),
    ("-8", -8, False), ("+2", 2, False), ("-12", -12, False), ("12", 12, False),
    ("13", 0, True), ("-80", 0, True),   # outside the range this setting allows
    ("better", 0, True), ("-1.5", 0, True), ("1500k", 0, True),
    ("１２", 0, True),                     # non-ASCII digits: int() reads them, ffmpeg does not
])
def test_the_value_is_read_as_steps_or_logged_and_ignored(raw, expected, logged, capsys):
    # Falling back is not enough on its own: the operator has to be able to find
    # out why nothing changed, so the log line is part of the behaviour.
    assert parse_crf_offset(raw) == expected
    assert ("TRANSCODER_CRF_OFFSET" in capsys.readouterr().out) is logged


def test_a_shifted_value_stays_inside_the_range_ffmpeg_takes():
    # The offset is bounded, the sum is not. ffmpeg refuses a CRF outside 0..51
    # and fails the whole job, so the clamp is what keeps a rung or output mode
    # added later from turning a configuration mistake into a failed upload.
    assert (shift_quality(20, -12), shift_quality(4, -12)) == (8, 0)
    assert (shift_quality(48, 12), shift_quality(24, 0)) == (51, 24)


@pytest.mark.parametrize("backend,option", [
    (None, "-crf"), ("nvenc", "-qp"),
    ("qsv", "-global_quality"), ("vaapi", "-global_quality"),
])
@pytest.mark.parametrize("level", sorted(COMPRESSION_LEVELS))
def test_every_step_shifts_every_rung_of_every_backend(backend, option, level):
    # The step the slider offers, through the job, onto each backend's own
    # quality option -- compared against the same command without the setting,
    # because what is under test is that the admin's choice moved every rung.
    offset = crf_offset_for_level(level)
    assert offset is not None
    before = _values_for(_ffmpeg_cmd_for(LADDER, backend=backend), option)
    after = _values_for(_ffmpeg_cmd_for(LADDER, backend=backend, crf_offset=offset), option)

    assert before, f"{backend or 'cpu'} emits no {option} to shift"
    assert after == {k: str(int(v) + offset) for k, v in before.items()}
    # The shift rewrites exactly the tokens #393 was about, so a bare one would
    # make the last rung's value win for the whole ladder again.
    assert [t for t in after if ":" not in t] == []


def test_the_default_step_leaves_the_ladder_exactly_as_it_was(monkeypatch):
    # The upgrade promise, at the level of the command: level 3 and an instance
    # that has chosen nothing have to produce the CRFs the ladder produced
    # before this setting existed.
    expected = {f"-crf:v:{i}": str(BASELINE_8BIT[q]) for i, q in enumerate(LADDER)}

    assert _values_for(_ffmpeg_cmd_for(LADDER), "-crf") == expected
    assert _values_for(
        _ffmpeg_cmd_for(LADDER, crf_offset=crf_offset_for_level(DEFAULT_COMPRESSION_LEVEL)),
        "-crf",
    ) == expected


def test_the_ten_bit_path_is_shifted_too(monkeypatch):
    # h265_10 subtracts four where the 8-bit path adds it, so it is a second
    # expression and a fix applied to one leaves the other at its old quality.
    monkeypatch.setenv("TRANSCODER_OUTPUT", "h265_10")
    cmd = _ffmpeg_cmd_for(LADDER, crf_offset=-8)

    assert _values_for(cmd, "-crf") == {
        f"-crf:v:{i}": str(QUALITY_MAP[q][1] - 12) for i, q in enumerate(LADDER)
    }


@pytest.mark.parametrize("backend,output,expected", [
    (None, "h264_8", {f"-aq-mode:v:{i}": "3" for i in range(len(LADDER))}),
    (None, "h265_10", {}),   # `aq-mode` is a private option of the libx264 wrapper
    ("nvenc", "h264_8", {}), # the hardware encoders quantise on the device
    ("qsv", "h264_8", {}),
    ("vaapi", "h264_8", {}),
])
def test_the_dark_scene_aq_mode_is_libx264_only(backend, output, expected, monkeypatch):
    # Mode 3 biases bits toward dark areas, which is where banding shows. It
    # belongs to ffmpeg's libx264 wrapper alone: the libx265 wrapper has no such
    # option (x265's lives behind `-x265-params`) and an option a codec does not
    # know is not reliably just a warning.
    monkeypatch.setenv("TRANSCODER_OUTPUT", output)
    cmd = _ffmpeg_cmd_for(LADDER, backend=backend)

    assert _values_for(cmd, "-aq-mode") == expected


@pytest.mark.parametrize("requested,env,expected", [
    (-8, "3", -8),     # the instance setting wins; that is why it is in the database
    (None, "3", 3),    # a caller with no opinion follows the environment
    (None, None, 0),   # and with neither, nothing shifts
    (99, "3", 3),      # off the scale: a bug upstream, logged, not clamped
])
def test_the_jobs_offset_wins_over_the_environment(requested, env, expected, monkeypatch):
    if env is not None:
        monkeypatch.setenv("TRANSCODER_CRF_OFFSET", env)

    assert job_crf_offset(requested) == expected


@pytest.mark.parametrize("offset,level", sorted((v, k) for k, v in COMPRESSION_LEVELS.items()))
def test_an_offset_is_named_only_by_the_step_that_means_exactly_it(offset, level):
    # Read backwards for the slider. It refuses to approximate: -5 is a
    # deliberate expert value no step names, and putting the thumb on the
    # nearest step would claim a setting the instance does not have.
    assert level_for_crf_offset(offset) == level
    assert level_for_crf_offset(offset - 1) is None
    # And a level off the scale reads as "not set", not as a clamped step.
    assert crf_offset_for_level(max(COMPRESSION_LEVELS) + 1) is None


@pytest.mark.parametrize("output", ["thumbnails", "poster", "copy"])
def test_the_outputs_that_are_not_review_streams_keep_their_own_quality(output, monkeypatch):
    # The thumbnail sheet and the poster frame are JPEGs on their own `-q:v 2`
    # scale, where a CRF offset means nothing, and a stream copy is the master's
    # own bits, where there is no encoder to shift. All three sit next to the
    # code the offset threads through, so they are pinned rather than left to
    # the next reader.
    monkeypatch.setenv("TRANSCODER_CRF_OFFSET", "-8")
    if output == "thumbnails":
        import asyncio
        from unittest.mock import MagicMock, patch

        from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder

        s3 = MagicMock()
        s3.generate_presigned_url.return_value = "https://s3.example.com/uploads/video.mp4"
        transcoder = FFmpegTranscoder(s3, "test-bucket")
        with patch.object(transcoder, "_run") as run, \
             patch("tempfile.mkdtemp", return_value="/tmp/thumbs"), \
             patch("shutil.rmtree"), \
             patch("pathlib.Path.glob", return_value=[]):
            asyncio.run(transcoder.generate_thumbnails("uploads/video.mp4", 3))
        cmds = [run.call_args[0][0]]
    elif output == "poster":
        _, _, commands = _transcode(LADDER, source_copy=None)
        cmds = [c for c in commands if "-frames:v" in c]
        assert cmds, "the poster command was not built"
    else:
        cmd, result, _ = _transcode(["1080p"])
        assert "copy" in cmd and result.success, "not the copy path"
        cmds = [cmd]

    for cmd in cmds:
        assert [t for t in cmd if t.split(":")[0] in
                ("-crf", "-aq-mode", "-global_quality", "-qp")] == []
        if output != "copy":
            assert _values_for(cmd, "-q") == {"-q:v": "2"}
