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
    COMPRESSION_LEVELS, crf_offset_for_level, level_for_crf_offset,
)
from packages.transcoder.ffmpeg_transcoder import (
    QUALITY_MAP, job_crf_offset, parse_crf_offset, shift_quality,
)

LADDER = ["1080p", "720p", "360p"]

# Every encoder option main builds for the default ladder, copied from
# `packages/transcoder/ffmpeg_transcoder.py` on main rather than derived from
# the code under test -- the point of the comparison is that this file does not
# follow the branch. The upgrade promise is that an instance which has chosen
# nothing still gets exactly this, so the whole run of options is pinned and
# not only `-crf`, which is how an added `-aq-mode` slipped past.
MAIN_DEFAULT_ENCODER_OPTIONS = [
    "-map", "[1080p]",
    "-c:v:0", "libx264", "-preset", "fast",
    "-force_key_frames:v:0", "expr:gte(t,n_forced*2)",
    "-pix_fmt:v:0", "yuv420p", "-crf:v:0", "24",
    "-map", "[720p]",
    "-c:v:1", "libx264", "-preset", "fast",
    "-force_key_frames:v:1", "expr:gte(t,n_forced*2)",
    "-pix_fmt:v:1", "yuv420p", "-crf:v:1", "26",
    "-map", "[360p]",
    "-c:v:2", "libx264", "-preset", "fast",
    "-force_key_frames:v:2", "expr:gte(t,n_forced*2)",
    "-pix_fmt:v:2", "yuv420p", "-crf:v:2", "30",
]


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
    # A pasted wall of digits: int() itself raises past about 4300 of them,
    # where nothing would catch it.
    pytest.param("9" * 4400, 0, True, id="4400-digits"),
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


@pytest.mark.parametrize("crf_offset", [None, 0])
def test_an_instance_that_has_chosen_nothing_gets_the_command_main_built(crf_offset):
    # The upgrade promise, at the level of the command. `None` is an instance
    # that has never touched the setting, `0` is the Balanced step, which is a
    # real choice of "what this always did"; both have to come out as main's
    # encoder options, token for token. Compared against a literal rather than
    # against the ladder's own numbers, because a comparison derived from this
    # branch cannot show a difference against main -- that is how the
    # unconditional `-aq-mode` got through.
    cmd = _ffmpeg_cmd_for(LADDER, crf_offset=crf_offset)
    start = cmd.index("-map")

    assert cmd[start:cmd.index("-f", start)] == MAIN_DEFAULT_ENCODER_OPTIONS


def test_the_ten_bit_path_is_shifted_too(monkeypatch):
    # h265_10 subtracts four where the 8-bit path adds it, so it is a second
    # expression and a fix applied to one leaves the other at its old quality.
    monkeypatch.setenv("TRANSCODER_OUTPUT", "h265_10")
    cmd = _ffmpeg_cmd_for(LADDER, crf_offset=-8)

    assert _values_for(cmd, "-crf") == {
        f"-crf:v:{i}": str(QUALITY_MAP[q][1] - 12) for i, q in enumerate(LADDER)
    }


@pytest.mark.parametrize("backend,output,offset,env,on", [
    (None, "h264_8", -4, None, True),     # a quality-raising step turns it on
    (None, "h264_8", None, "-4", True),   # from the environment just the same
    (None, "h264_8", None, None, False),  # unset: main's command, token for token
    (None, "h264_8", 0, None, False),     # Balanced is a real choice of "as before"
    (None, "h264_8", 0, "-5", False),     # and it holds over a negative environment value
    (None, "h264_8", 6, None, False),     # smaller files is not asking for more bits
    (None, "h265_10", -4, None, False),   # `aq-mode` is private to the libx264 wrapper
    ("nvenc", "h264_8", -4, None, False),  # the hardware encoders quantise on the device
    ("qsv", "h264_8", -4, None, False),
    ("vaapi", "h264_8", -4, None, False),
])
def test_the_dark_scene_aq_mode_rides_on_a_quality_raising_step(
    backend, output, offset, env, on, monkeypatch
):
    # Mode 3 biases bits toward dark areas, which is where banding shows, so it
    # belongs with the steps an instance moves to for exactly that reason -- and
    # nowhere else: at an effective offset of 0 the command has to stay the one
    # main builds, or an upgrade changes every CPU-only install's output. It
    # also belongs to ffmpeg's libx264 wrapper alone: the libx265 wrapper has no
    # such option (x265's lives behind `-x265-params`) and an option a codec
    # does not know is not reliably just a warning.
    monkeypatch.setenv("TRANSCODER_OUTPUT", output)
    if env is not None:
        monkeypatch.setenv("TRANSCODER_CRF_OFFSET", env)
    cmd = _ffmpeg_cmd_for(LADDER, backend=backend, crf_offset=offset)

    expected = {f"-aq-mode:v:{i}": "3" for i in range(len(LADDER))} if on else {}
    assert _values_for(cmd, "-aq-mode") == expected


@pytest.mark.parametrize("requested,env,expected", [
    (-8, "3", -8),     # the instance setting wins; that is why it is in the database
    (0, "-8", 0),      # Balanced too: it is a choice of 0, not an absent one
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
