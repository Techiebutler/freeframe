"""A transcode that stops early must not be stored as a finished one.

The case behind this file, from a live instance: a 31:18 master came out as
1:37 of HLS, and the version was saved `ready` with the source's real duration
beside it. Nothing had gone wrong as far as the code could tell -- ffmpeg
exited 0 and the playlist carried `#EXT-X-ENDLIST` -- because exit code is the
only thing the transcoder looks at.

It is reachable whenever the input stops being readable at a frame boundary:
the demuxer cannot tell that from the end of the file. Measured on the real
master, truncated at three successive frame boundaries, exit code 0 each time
with 92.4s, 96.1s and 99.8s of output. Truncated one byte *inside* a frame it
exits 183, which is why this is rare -- and why, being rare, it went unnoticed
for two days and would have gone unnoticed longer.

Every claim here was checked by breaking the code and watching a test go red;
the mutations are listed in the pull request. That includes the ones that are
easy to get wrong in the other direction: a check that refuses intact files is
worse than no check, because a refusal that reproduces on every read exhausts
the retries, lands the version on `failed`, and the stale-upload reaper deletes
the master a day later.
"""
import json
import os

import pytest

from packages.transcoder.ffmpeg_transcoder import (
    TranscodeTruncated,
    hls_output_seconds,
    parse_probe_metadata,
    refuse_a_truncated_result,
)


def _variant(tmp_path, name: str, segment_seconds: list[float]):
    """Write a playlist the way the HLS muxer writes one."""
    d = tmp_path / name
    d.mkdir(parents=True, exist_ok=True)
    lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-TARGETDURATION:3",
             "#EXT-X-PLAYLIST-TYPE:VOD"]
    for i, s in enumerate(segment_seconds):
        lines += [f"#EXTINF:{s:.6f},", f"seg_{i:03d}.ts"]
    lines.append("#EXT-X-ENDLIST")
    (d / "playlist.m3u8").write_text("\n".join(lines) + "\n")
    return d


# ----------------------------------------- which duration the check may use
#
# The subtle half of this feature. `#EXTINF` measures the video timeline; a
# container's duration is its longest stream. Comparing one against the other
# refuses intact files, silently and only on some containers, which is the
# worst shape a check can have.

def test_an_mp4_reports_the_same_duration_twice():
    # MP4, MOV and AVI carry a per-stream duration, so both numbers agree and
    # the distinction never shows. This is the common case and the reason the
    # bug below is easy to miss.
    meta = parse_probe_metadata({
        "streams": [{"duration": "600.000000", "width": 1920, "height": 1080,
                     "r_frame_rate": "25/1"}],
        "format": {"duration": "600.000000"},
    })
    assert meta.duration_seconds == pytest.approx(600.0)
    assert meta.video_duration_seconds == pytest.approx(600.0)


def test_matroska_reports_the_video_track_separately_from_the_file():
    # Measured on a real file built for this: a 20s picture with a 35s sine
    # muxed beside it. `ffprobe -select_streams v:0` on it gives exactly this --
    # no stream duration, DURATION as a tag, and the container reporting the
    # audio. An NLE rough cut and a MediaRecorder capture both produce it.
    meta = parse_probe_metadata({
        "streams": [{"width": 1920, "height": 1080, "r_frame_rate": "25/1",
                     "start_time": "0.000000",
                     "tags": {"DURATION": "00:00:20.023000000"}}],
        "format": {"duration": "35.023000"},
    })
    # What the player, the database and the comment timecodes mean by "long":
    assert meta.duration_seconds == pytest.approx(35.023)
    # What an EXTINF sum may be compared against:
    assert meta.video_duration_seconds == pytest.approx(20.023)


def test_the_duration_tag_is_an_end_timestamp_and_the_offset_comes_off():
    # The correction that is easy to leave out and impossible to notice
    # afterwards. ffmpeg writes Matroska's DURATION as zero-to-last-packet, so
    # a picture that starts late reports more than it holds.
    #
    # Built with ffmpeg and probed: `-itsoffset 3` gives start_time 3.023 and
    # DURATION 00:00:33.023 for 750 packets at 25fps, which is 30.0s of
    # picture. Without the subtraction a complete ladder is refused at 91%,
    # and -- because a metadata mismatch reproduces on every read -- the upload
    # ends at `failed` and its master is reaped.
    meta = parse_probe_metadata({
        "streams": [{"width": 320, "height": 240, "r_frame_rate": "25/1",
                     "start_time": "3.023000",
                     "tags": {"DURATION": "00:00:33.023000000"}}],
        "format": {"duration": "33.023000"},
    })
    assert meta.video_duration_seconds == pytest.approx(30.0)


def test_an_mp4_duration_is_a_length_and_is_left_alone():
    # The mirror, and the reason the subtraction cannot simply be applied
    # everywhere: MP4's per-stream duration is a track length already.
    # Measured on the same `-itsoffset 3` source written as mp4: start_time
    # 3.000000 alongside duration 30.000000.
    meta = parse_probe_metadata({
        "streams": [{"duration": "30.000000", "width": 320, "height": 240,
                     "r_frame_rate": "25/1", "start_time": "3.000000"}],
        "format": {"duration": "33.000000"},
    })
    assert meta.video_duration_seconds == pytest.approx(30.0)


def test_an_hour_long_duration_tag_is_read_as_hours():
    # Verified against a real 3700s Matroska, which reports
    # "DURATION": "01:01:40.000000000". Getting the hours multiplier wrong is
    # invisible on every short fixture and catastrophic on every long upload:
    # too large refuses each one permanently, too small switches the check off.
    meta = parse_probe_metadata({
        "streams": [{"width": 1920, "height": 1080, "r_frame_rate": "25/1",
                     "tags": {"DURATION": "01:01:40.000000000"}}],
        "format": {"duration": "3700.000000"},
    })
    assert meta.video_duration_seconds == pytest.approx(3700.0)


def test_a_language_suffixed_duration_tag_still_counts():
    # ffmpeg writes DURATION-eng when the track carries a language.
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1",
                     "tags": {"language": "eng",
                              "DURATION-eng": "00:01:00.000000000"}}],
        "format": {"duration": "90.000000"},
    })
    assert meta.video_duration_seconds == pytest.approx(60.0)


def test_a_lowercase_duration_tag_still_counts():
    # Tag keys come back uppercase from every muxer measured; this holds the
    # case-folding that makes that an observation rather than an assumption.
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1",
                     "tags": {"duration": "00:01:00.000000000"}}],
        "format": {"duration": "90.000000"},
    })
    assert meta.video_duration_seconds == pytest.approx(60.0)


def test_no_video_duration_anywhere_is_none_rather_than_the_container():
    # A Matroska written to a pipe, which carries neither field nor tag. The
    # container number is still wrong for this purpose, so the field stays
    # empty; the transcode probes for the answer instead (below).
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1"}],
        "format": {"duration": "90.000000"},
    })
    assert meta.duration_seconds == pytest.approx(90.0)
    assert meta.video_duration_seconds is None


@pytest.mark.parametrize("tag, why", [
    ("N/A", "ffprobe's own placeholder"),
    ("00:00", "minutes and seconds only, no hours field"),
    ("00:00:00.000000000", "a zero extent says nothing"),
    ("00:31:18,123", "comma decimal separator"),
])
def test_an_unusable_duration_tag_is_ignored(tag, why):
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1",
                     "tags": {"DURATION": tag}}],
        "format": {"duration": "90.000000"},
    })
    assert meta.video_duration_seconds is None, why


def test_a_tag_shorter_than_the_offset_is_ignored_rather_than_negative():
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1",
                     "start_time": "50.0",
                     "tags": {"DURATION": "00:00:30.000000000"}}],
        "format": {"duration": "90.000000"},
    })
    assert meta.video_duration_seconds is None


def test_an_unreadable_start_time_is_treated_as_zero():
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1",
                     "start_time": "N/A",
                     "tags": {"DURATION": "00:00:30.000000000"}}],
        "format": {"duration": "90.000000"},
    })
    assert meta.video_duration_seconds == pytest.approx(30.0)


def test_a_stream_duration_is_preferred_over_a_tag():
    # Both present: the field is authoritative, the tag is what a muxer wrote.
    meta = parse_probe_metadata({
        "streams": [{"duration": "600.000000", "width": 1920, "height": 1080,
                     "r_frame_rate": "25/1",
                     "tags": {"DURATION": "00:00:20.000000000"}}],
        "format": {"duration": "600.000000"},
    })
    assert meta.video_duration_seconds == pytest.approx(600.0)


# ------------------------------------------------------- reading the playlist

def test_the_length_comes_from_the_playlist_not_the_segment_count(tmp_path):
    # Segment length varies with the frame rate, and on the copy path it comes
    # from the source's GOP rather than -hls_time, so counting files and
    # multiplying would be wrong on exactly the path this bug was found on.
    _variant(tmp_path, "0", [2.9029, 1.935267, 1.935267, 0.433767])
    assert hls_output_seconds(tmp_path) == pytest.approx(7.207201)


def test_the_longest_variant_wins(tmp_path):
    # A ladder writes one playlist per rung. They should agree; if they do not,
    # the longest is the one that says how much of the source was read.
    #
    # The long one is deliberately *not* the first the glob returns: with the
    # longest also sorting first, an implementation that simply kept the first
    # playlist it read would pass this and lose a truncated rung.
    _variant(tmp_path, "0", [2.0, 2.0])
    _variant(tmp_path, "1", [2.0, 2.0, 2.0])
    assert hls_output_seconds(tmp_path) == pytest.approx(6.0)


def test_the_longest_variant_wins_in_either_order(tmp_path):
    # And the mirror, so neither "first" nor "last" passes by accident.
    _variant(tmp_path, "0", [2.0, 2.0, 2.0])
    _variant(tmp_path, "1", [2.0, 2.0])
    assert hls_output_seconds(tmp_path) == pytest.approx(6.0)


def test_a_directory_with_no_playlist_reads_as_none(tmp_path):
    assert hls_output_seconds(tmp_path) is None


def test_a_malformed_line_does_not_lose_the_rest(tmp_path):
    d = tmp_path / "0"
    d.mkdir()
    (d / "playlist.m3u8").write_text(
        "#EXTM3U\n#EXTINF:2.000000,\nseg_000.ts\n"
        "#EXTINF:not-a-number,\nseg_001.ts\n"
        "#EXTINF:2.000000,\nseg_002.ts\n#EXT-X-ENDLIST\n"
    )
    # Better to under-report by one segment than to raise here: the caller is
    # deciding whether to keep a transcode, and an exception would fail it for
    # the wrong reason.
    assert hls_output_seconds(d.parent) == pytest.approx(4.0)


@pytest.mark.parametrize("value", ["nan", "inf", "-inf"])
def test_a_non_finite_segment_length_is_not_summed(tmp_path, value):
    # `nan` loses every comparison, so one of them would make the check accept
    # any ladder at all; `inf` swamps the sum to the same effect. Neither has
    # been seen out of ffmpeg -- this is a floor under the arithmetic, not a
    # reported failure.
    d = tmp_path / "0"
    d.mkdir()
    (d / "playlist.m3u8").write_text(
        f"#EXTM3U\n#EXTINF:2.000000,\nseg_000.ts\n"
        f"#EXTINF:{value},\nseg_001.ts\n#EXT-X-ENDLIST\n"
    )
    assert hls_output_seconds(d.parent) == pytest.approx(2.0)


def test_a_playlist_that_cannot_be_read_does_not_escape(tmp_path):
    # A path matching the glob that is not a readable file -- here a directory
    # of that name. An OSError out of here would bypass the attempt loop's
    # RuntimeError handler and burn the hardware and remux fallbacks on a
    # filesystem hiccup.
    (tmp_path / "0" / "playlist.m3u8").mkdir(parents=True)
    _variant(tmp_path, "1", [2.0, 2.0])
    assert hls_output_seconds(tmp_path) == pytest.approx(4.0)


# --------------------------------------------------------------- the refusal

def test_a_full_length_ladder_is_accepted(tmp_path):
    _variant(tmp_path, "0", [2.0] * 50)
    refuse_a_truncated_result(tmp_path, 100.0)


def test_the_live_case_is_refused(tmp_path):
    # The numbers that were actually stored: 97.2s of a 1877.7s master.
    _variant(tmp_path, "0", [1.935267] * 50 + [0.433767])
    assert hls_output_seconds(tmp_path) == pytest.approx(97.2, abs=0.05)
    with pytest.raises(TranscodeTruncated) as exc:
        refuse_a_truncated_result(tmp_path, 1877.709167, label="ffmpeg (copy)")
    message = str(exc.value)
    assert "5%" in message
    assert "1877.7s" in message
    assert "ffmpeg (copy)" in message


def test_a_ladder_longer_than_its_source_is_accepted(tmp_path):
    # The check is one-sided on purpose. A copied ladder ends where the GOP
    # ends and an encoded one pads to the next frame, so output past the
    # source's last timestamp is ordinary -- measured at +0.040s on the encode
    # path, and larger when a late-starting picture is padded from zero.
    # Making the tolerance symmetric would refuse those.
    _variant(tmp_path, "0", [2.0] * 60)
    refuse_a_truncated_result(tmp_path, 100.0)


def test_an_intact_source_whose_audio_outlives_its_video_is_accepted(tmp_path):
    # A 20s picture in a 35s file. This is the function's half of the story;
    # `test_a_matroska_with_an_audio_tail_is_not_refused_end_to_end` is the
    # half that holds the call site to handing over the right number.
    _variant(tmp_path, "0", [2.0] * 10 + [0.023])
    refuse_a_truncated_result(tmp_path, 20.023)


def test_a_last_segment_cut_short_is_not_a_truncation(tmp_path):
    # The muxer ends the last segment where the frames end, so an exact match
    # is not on offer. Measured drift on a complete ladder: +0.023s on the copy
    # path, -0.040s on the encode path, at 1, 10 and 40 minutes alike.
    _variant(tmp_path, "0", [2.0] * 49 + [1.5])
    refuse_a_truncated_result(tmp_path, 100.0)


def test_the_slack_is_three_seconds_and_is_pinned_from_both_sides(tmp_path):
    # A slack is only as good as its upper bound: raising the floor is
    # invisible to a test that only checks that rounding is tolerated. These
    # bracket it to (2.9s, 3.1s], which is tight enough that the measured drift
    # of 0.04s and the claim that 3s is 75 times it both stay honest.
    knapp, drueber = tmp_path / "knapp", tmp_path / "drueber"
    _variant(knapp, "0", [2.0] * 48 + [1.1])       # 97.1s of 100s, inside
    refuse_a_truncated_result(knapp, 100.0)

    _variant(drueber, "0", [2.0] * 48 + [0.9])     # 96.9s of 100s, outside
    with pytest.raises(TranscodeTruncated):
        refuse_a_truncated_result(drueber, 100.0)


def test_exactly_the_slack_short_is_still_accepted(tmp_path):
    # The boundary itself, so `<` cannot quietly become `<=`. 97.0s of a 100s
    # source is exactly three seconds short and is rounding, not truncation.
    _variant(tmp_path, "0", [2.0] * 48 + [1.0])
    refuse_a_truncated_result(tmp_path, 100.0)


def test_the_slack_does_not_grow_with_the_source(tmp_path):
    # The same shortfall on a 40-minute master. A proportional term would
    # forgive up to 24s here and let a quarter-minute of missing video through
    # on a long file while catching it on a short one.
    _variant(tmp_path, "0", [2.0] * 1198 + [0.9])   # 2396.9s of 2400s
    with pytest.raises(TranscodeTruncated):
        refuse_a_truncated_result(tmp_path, 2400.0)


def test_no_playlist_at_all_is_deliberately_not_judged(tmp_path):
    # ffmpeg with an HLS muxer either writes a playlist or exits non-zero, so
    # an empty directory here means the output layout moved rather than that a
    # transcode was cut short -- and failing every asset over a renamed
    # directory is the worse error. The wiring tests below are what keep this
    # from being a quiet way for the whole check to stop applying.
    refuse_a_truncated_result(tmp_path, 100.0)


def test_an_unknown_source_duration_cannot_be_judged(tmp_path):
    # Refusing here would turn a missing number into a failed asset -- and,
    # through the reaper, into a deleted master.
    #
    # Honest about what this holds: `None` is pinned, because dropping the
    # guard makes the comparison raise TypeError. `0.0` takes the same branch
    # and cannot fail on its own, since no comparison against zero raises; it
    # is asserted as documentation of the contract, not as cover.
    _variant(tmp_path, "0", [2.0])
    refuse_a_truncated_result(tmp_path, None)
    refuse_a_truncated_result(tmp_path, 0.0)


# ------------------------------------------------------------- the wiring
#
# What has to stay true in the transcode itself, none of it visible to a test
# of the function alone:
#
#   * the check runs on the branch production actually takes -- with a
#     progress callback, which `process_asset` always passes, and which goes
#     through Popen rather than subprocess.run,
#   * it runs on the copy path, which is the path the incident happened on,
#   * it runs on a later attempt, not only the first,
#   * it is handed the video track's length and never the container's,
#   * nothing is uploaded when it refuses, and
#   * a refusal is not absorbed by the fallback to the encoder.
#
# Each has its own test, because each can be broken without the others
# noticing -- and several of these exist because they were broken and nothing
# noticed.


def _drive_a_transcode(
    tmp_path, written_seconds, source_seconds=600.0, *,
    copy_path=False, with_progress=True, video_stream=None, audio_stream=None,
    format_duration=None, tail_packets=None, first_attempt_fails=False,
    first_attempt_writes_first=False,
):
    """Run the real transcode with a mocked ffmpeg that writes a real playlist.

    The mock does what ffmpeg does rather than only reporting that it did: it
    reads the output path out of the command it was handed and writes a
    playlist there. Without that, nothing here would notice the check being
    removed from the transcode.

    Both process launchers are mocked. `process_asset` always passes a
    `progress_cb`, and that branch runs ffmpeg through `Popen`, so a driver
    that only patched `subprocess.run` would cover the branch production never
    takes -- which is how the check came to be testable and untested at once.

    Returns `(result, s3, commands)`.
    """
    import asyncio
    import subprocess
    from pathlib import Path
    from unittest.mock import MagicMock, patch

    from packages.transcoder.base import TranscodeJob
    from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder

    stream = video_stream if video_stream is not None else {
        "codec_name": "h264", "pix_fmt": "yuv420p", "r_frame_rate": "25/1",
        "duration": f"{source_seconds:.6f}", "width": 1920, "height": 1080,
        "start_time": "0.000000",
    }
    fmt = {"duration": f"{format_duration if format_duration is not None else source_seconds:.6f}"}
    audio = [audio_stream] if audio_stream else []
    commands: list[list[str]] = []
    attempts = {"hls": 0}

    def _write_playlist(cmd, seconds):
        target = Path(cmd[-1])                          # <work>/hls/%v/playlist.m3u8
        variant = Path(str(target.parent).replace("%v", "0"))
        variant.mkdir(parents=True, exist_ok=True)
        whole, rest = divmod(seconds, 2.0)
        lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-PLAYLIST-TYPE:VOD"]
        for i in range(int(whole)):
            lines += ["#EXTINF:2.000000,", f"seg_{i:03d}.ts"]
        if rest:
            lines += [f"#EXTINF:{rest:.6f},", f"seg_{int(whole):03d}.ts"]
        lines.append("#EXT-X-ENDLIST")                  # as ffmpeg leaves it
        (variant / "playlist.m3u8").write_text("\n".join(lines) + "\n")
        (variant / "seg_000.ts").write_bytes(b"\x47" * 188)

    def _hls_seconds(cmd):
        """How long the ladder this invocation writes comes out.

        `written_seconds` may be a per-attempt list, so a run can fail its
        first backend at runtime and produce a short ladder on the fallback.
        """
        index = attempts["hls"]
        attempts["hls"] += 1
        if isinstance(written_seconds, (list, tuple)):
            return written_seconds[min(index, len(written_seconds) - 1)]
        return written_seconds

    def _answer(cmd):
        """What a run of `cmd` produces, as (returncode, stdout, stderr)."""
        commands.append(cmd)
        if cmd[0] == "ffprobe":
            # The tail probe asks about every stream at once, so it carries no
            # -select_streams and must be matched before the selector below.
            if "packet=pts_time,codec_type" in cmd:
                return 0, json.dumps({"packets": tail_packets or []}), ""
            selected = (cmd[cmd.index("-select_streams") + 1]
                        if "-select_streams" in cmd else "")
            if selected != "v:0":
                return 0, json.dumps({"streams": audio}), ""
            if "packet=pts_time,flags" in cmd:
                # The copy path's keyframe probe: a closed GOP every two
                # seconds, which is what makes a remux allowed at all.
                #
                # It answers per window. The transcoder probes the head and the
                # tail, and a mock that always replies with head keyframes
                # makes the tail window look like one enormous gap -- the copy
                # is then refused, the run quietly becomes an encode, and a
                # test that believes it covers the copy path covers nothing.
                interval = cmd[cmd.index("-read_intervals") + 1]
                start_text, _, length_text = interval.partition("%+")
                start = float(start_text) if start_text else 0.0
                length = float(length_text)
                return 0, json.dumps({"packets": [
                    {"pts_time": f"{start + t:.3f}", "flags": "K_"}
                    for t in range(0, int(length) + 1, 2)
                ]}), ""
            return 0, json.dumps({"streams": [stream], "format": fmt}), ""
        if cmd[0] == "ffmpeg" and "trace_headers" in cmd:
            # Every sync sample an IDR, no recovery points: copyable. The count
            # has to match the keyframes reported for the same window, or the
            # transcoder refuses the copy and the run becomes an encode.
            length = float(cmd[cmd.index("-t") + 1])
            return 0, "", "\n".join(
                "[trace_headers @ 0x1] nal_unit_type: 5(IDR)"
                for _ in range(0, int(length) + 1, 2)
            )
        if "-f" in cmd and cmd[cmd.index("-f") + 1] == "hls":
            if first_attempt_fails and attempts["hls"] == 0:
                # A remux that fails on its own terms, which is what the
                # fallback to the encoder exists for (#372). It may have written
                # part of a ladder before dying, which is what ffmpeg does.
                if first_attempt_writes_first:
                    _write_playlist(cmd, _hls_seconds(cmd))
                else:
                    attempts["hls"] += 1
                return 1, "", "Invalid data found when processing input"
            _write_playlist(cmd, _hls_seconds(cmd))
        return 0, "", ""

    def run(cmd, **_kwargs):
        rc, out, err = _answer(cmd)
        mock = MagicMock()
        mock.returncode, mock.stdout, mock.stderr = rc, out, err
        if rc != 0 and _kwargs.get("check"):
            raise subprocess.CalledProcessError(rc, cmd, out, err)
        return mock

    def popen(cmd, stdout=None, stderr=None, **_kwargs):
        # `_run_with_progress` inserts `-progress pipe:1 -nostats` after argv[0]
        # and then reads argv[-1] as the output path, exactly as here.
        rc, _out, err = _answer([cmd[0], *cmd[3:]])
        if stderr is not None:
            stderr.write(err)
        read_fd, write_fd = os.pipe()
        os.close(write_fd)                       # immediate EOF: no progress lines
        proc = MagicMock()
        proc.stdout.fileno.return_value = read_fd
        proc.poll.return_value = rc
        proc.wait.return_value = rc
        proc.returncode = rc
        proc.stdout.close.side_effect = lambda: os.close(read_fd)
        return proc

    s3 = MagicMock()
    s3.generate_presigned_url.return_value = "https://s3.example.com/in.mp4"
    job = TranscodeJob(
        media_id="m1", version_id="v1", input_s3_key="raw/in.mp4",
        output_s3_prefix="processed/m1/v1", qualities=["1080p"],
        progress_cb=(lambda _percent: None) if with_progress else None,
    )
    env = {}
    if copy_path:
        env["TRANSCODER_SOURCE_COPY"] = "1"
    with patch.dict(os.environ, env, clear=False), \
            patch("subprocess.run", side_effect=run), \
            patch("subprocess.Popen", side_effect=popen):
        result = asyncio.run(FFmpegTranscoder(s3, "bucket").transcode(job))
    return result, s3, commands


def _hls_commands(commands):
    return [c for c in commands if "-f" in c and c[c.index("-f") + 1] == "hls"]


@pytest.mark.parametrize("with_progress", [True, False])
def test_the_check_is_wired_into_the_encode_path(tmp_path, with_progress):
    # `process_asset` passes a progress callback on every video job, and that
    # branch runs ffmpeg through Popen. Parametrised so the check cannot be
    # moved into the branch nobody runs while the suite stays green.
    #
    # The assertion is on the result rather than on a raised exception because
    # `transcode` turns every exception into `TranscodeResult(success=False)`.
    # That is the contract the task reads: `not result.success` makes it raise,
    # and the task retries three times a minute apart, which for a read that
    # ended early is exactly the right remedy.
    result, _, _ = _drive_a_transcode(
        tmp_path, written_seconds=98.0, source_seconds=600.0,
        with_progress=with_progress,
    )
    assert result.success is False
    assert "16%" in result.error
    assert "600.0s source" in result.error


@pytest.mark.parametrize("with_progress", [True, False])
def test_the_check_is_wired_into_the_copy_path(tmp_path, with_progress):
    # The path the incident actually happened on, and the one a check can be
    # dropped from while every other test here stays green.
    result, _, commands = _drive_a_transcode(
        tmp_path, written_seconds=98.0, source_seconds=600.0, copy_path=True,
        with_progress=with_progress,
    )
    assert result.success is False
    assert "16%" in result.error
    # Not just the message: the ladder really was built by a remux. Without
    # this the run could silently have fallen back to the encoder.
    assert any(any(c[i].startswith("-c:v") and c[i + 1] == "copy"
                   for i in range(len(c) - 1))
               for c in _hls_commands(commands))
    assert "(copy)" in result.error


def test_the_check_runs_on_a_later_attempt_too(tmp_path):
    # A remux that fails on its own terms falls back to the encoder, and that
    # second ladder is checked like any other. Only pinning the first attempt
    # would leave every fallback run unguarded, which is a live path: the
    # attempt list is built to hold two or three entries, and a self-hosted
    # instance with the copy path on reaches it whenever a remux is refused.
    result, _, commands = _drive_a_transcode(
        tmp_path, written_seconds=[0.0, 98.0], source_seconds=600.0,
        copy_path=True, first_attempt_fails=True,
    )
    assert len(_hls_commands(commands)) == 2, "the fallback attempt must have run"
    assert result.success is False
    assert "16%" in result.error
    assert "(cpu)" in result.error, "the refusal came from the fallback attempt"


def test_an_attempt_that_died_after_writing_does_not_vouch_for_the_next(tmp_path):
    # The remux writes a full 600s ladder, dies anyway, and the encoder that
    # follows manages only 98s. The short one is what counts.
    #
    # What this does *not* hold: `hls_output_seconds` takes the longest variant
    # it finds, so a stale playlist left by a dead attempt would vouch for its
    # successor -- but it cannot survive to do so, because every attempt writes
    # the same playlist paths and truncates them. The copy path is only ever
    # chosen with a single rung (`len(qualities) == 1`), so its fallback encode
    # writes variant `0` exactly as the copy did. Deleting the `shutil.rmtree`
    # between attempts therefore changes nothing here, and I did not invent a
    # test to pretend otherwise. It would start to matter if attempts were ever
    # given separate output directories.
    result, _, commands = _drive_a_transcode(
        tmp_path, written_seconds=[600.0, 98.0], source_seconds=600.0,
        copy_path=True, first_attempt_fails=True, first_attempt_writes_first=True,
    )
    assert len(_hls_commands(commands)) == 2, "the fallback attempt must have run"
    assert result.success is False
    assert "16%" in result.error


def test_a_refused_transcode_uploads_nothing(tmp_path):
    # The check runs before the ladder goes to the bucket, not after. If it
    # moved below the upload the transcode would still fail -- and a short
    # ladder would still be sitting in the store under the version's prefix.
    result, s3, _ = _drive_a_transcode(
        tmp_path, written_seconds=98.0, source_seconds=600.0, copy_path=True,
    )
    assert result.success is False
    assert s3.upload_file.call_count == 0
    assert s3.put_object.call_count == 0


def test_a_refused_copy_does_not_fall_back_to_the_encoder(tmp_path):
    # A remux that fails on its own terms is worth encoding instead (#372). A
    # remux that stopped early is worth *reading again*: the source is intact,
    # so a fresh read is the remedy and the task already retries. Falling back
    # here would re-read the same input the same way and cost hours doing it.
    #
    # The encoder would produce a full-length ladder on its attempt, so without
    # `except TranscodeTruncated: raise` this transcode reports success.
    result, _, commands = _drive_a_transcode(
        tmp_path, written_seconds=[98.0, 600.0], source_seconds=600.0,
        copy_path=True,
    )
    assert result.success is False
    assert "the read ended early" in result.error
    assert len(_hls_commands(commands)) == 1, "the encoder must not have run"


def test_a_full_length_transcode_passes_the_check(tmp_path):
    # The control. A ladder as long as its source must get past the check.
    # Asserting only on the absence of *this* failure keeps the test from
    # depending on what the surrounding mocks do afterwards.
    result, _, _ = _drive_a_transcode(
        tmp_path, written_seconds=600.0, source_seconds=600.0,
    )
    assert "the read ended early" not in (result.error or "")


def test_a_matroska_with_an_audio_tail_is_not_refused_end_to_end(tmp_path):
    # Blocker 1 as the transcode sees it: a 600s picture beside a 900s audio
    # track, so the container reports 900s. The ladder is complete. Handing the
    # check the container's number refuses it at 67%, and because the mismatch
    # reproduces on every read the upload ends at `failed` and its master is
    # reaped a day later.
    result, _, _ = _drive_a_transcode(
        tmp_path,
        written_seconds=600.0,
        source_seconds=600.0,
        video_stream={
            "codec_name": "h264", "pix_fmt": "yuv420p", "r_frame_rate": "25/1",
            "width": 1920, "height": 1080, "start_time": "0.000000",
            "tags": {"DURATION": "00:10:00.000000000"},
        },
        audio_stream={"codec_name": "aac", "duration": "900.000000"},
        format_duration=900.0,
    )
    assert "the read ended early" not in (result.error or "")


# A container that publishes no per-stream video duration -- FLV never does,
# nor does a Matroska written to a pipe. All that is left is the container's
# own duration, and one probe of the tail says what that number is about. The
# three shapes below are taken from real files; the numbers are in
# `_probe_expected_video_seconds`.
_NO_VIDEO_DURATION = {
    "codec_name": "h264", "pix_fmt": "yuv420p", "r_frame_rate": "25/1",
    "width": 1920, "height": 1080,
}


def test_a_source_that_falls_short_of_its_own_claim_is_refused(tmp_path):
    # The truncated-FLV shape: the container says 600s, and nothing is readable
    # anywhere near that -- the last packet of any stream is at 60s. The file
    # was cut short, and 600s is still what it was supposed to hold.
    #
    # Measured before this existed: 10% of a 300s FLV master was accepted as
    # complete, exit code 0 -- the original incident, through the new check.
    result, _, commands = _drive_a_transcode(
        tmp_path, written_seconds=60.0, source_seconds=600.0,
        video_stream=_NO_VIDEO_DURATION,
        tail_packets=[{"pts_time": "59.960", "codec_type": "video"},
                      {"pts_time": "59.980", "codec_type": "audio"}],
    )
    assert any("packet=pts_time,codec_type" in c for c in commands)
    assert result.success is False
    assert "10%" in result.error
    assert "600.0s source" in result.error


def test_a_source_readable_to_its_claim_is_measured_not_assumed(tmp_path):
    # The intact-FLV shape: readable right up to the claim, so the picture's
    # own last packet is the length, and a complete ladder passes.
    result, _, _ = _drive_a_transcode(
        tmp_path, written_seconds=600.0, source_seconds=600.0,
        video_stream=_NO_VIDEO_DURATION,
        tail_packets=[{"pts_time": "599.960", "codec_type": "video"},
                      {"pts_time": "599.980", "codec_type": "audio"}],
    )
    assert "the read ended early" not in (result.error or "")


def test_an_audio_tail_without_a_published_duration_is_not_a_truncation(tmp_path):
    # The third shape, and the one that decides whether this probe is safe: the
    # file is readable to its claimed 600s, but the picture stops at 300s
    # because the audio runs on. The ladder is complete at 300s. Comparing
    # against the claim would refuse it at 50%.
    result, _, _ = _drive_a_transcode(
        tmp_path, written_seconds=300.0, source_seconds=600.0,
        video_stream=_NO_VIDEO_DURATION,
        tail_packets=[{"pts_time": "299.960", "codec_type": "video"},
                      {"pts_time": "599.980", "codec_type": "audio"}],
    )
    assert "the read ended early" not in (result.error or "")


def test_a_window_with_no_picture_at_all_declines(tmp_path):
    # Readable to the end, but the picture ended more than a probe window
    # before it. Nothing here can say how long it ran, so nothing is claimed.
    result, _, _ = _drive_a_transcode(
        tmp_path, written_seconds=60.0, source_seconds=600.0,
        video_stream=_NO_VIDEO_DURATION,
        tail_packets=[{"pts_time": "599.980", "codec_type": "audio"}],
    )
    assert "the read ended early" not in (result.error or "")


def test_a_probe_that_says_nothing_declines_instead_of_failing(tmp_path):
    # An undecidable file -- a piped Matroska has no container duration to aim
    # the window at either. The transcode proceeds; it must not be failed for
    # the absence of a number.
    result, _, _ = _drive_a_transcode(
        tmp_path, written_seconds=60.0, source_seconds=600.0,
        video_stream=_NO_VIDEO_DURATION, format_duration=0.0, tail_packets=[],
    )
    assert "the read ended early" not in (result.error or "")
