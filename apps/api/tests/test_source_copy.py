"""Stream copy has to reach the ffmpeg command, and only where it is allowed.

Two mistakes are possible here and both are silent. One is the setting doing
nothing, so an instance that turned it on still spends an hour per master. The
other is the opposite and worse: copying a source that should have been encoded,
which produces an asset that plays for nobody -- 10-bit H.264 reports the same
codec name as the 8-bit kind, and an HDR master copied without tone-mapping is
grey. So every test here reads the command that was actually built, and the ones
that must *not* copy outnumber the ones that must.
"""
import asyncio
import json
import os
from unittest.mock import MagicMock, patch

from packages.transcoder.base import TranscodeJob
from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder


_H264_8BIT = {"codec_name": "h264", "pix_fmt": "yuv420p"}


def _transcode(
    qualities: list[str],
    source: tuple[int, int] = (1920, 1080),
    video_stream: dict | None = None,
    audio_streams: list[dict] | None = None,
    source_copy: str | None = "true",
    keyframes: list[float] | None = None,
    open_gop: bool = False,
    idrs: int | None = None,
    tail_open_gop: bool = False,
    trace_silent: bool = False,
    remux_fails: bool = False,
    hls_commands: int = 1,
):
    """Run a transcode with everything mocked; return (hls command, result).

    The keyframe probe is mocked from `keyframes` and `open_gop`: by default a
    well-behaved master with an IDR every two seconds, which is what a copy
    needs and what an NLE exports.
    """
    width, height = source
    stream = {"r_frame_rate": "25/1", "duration": 6.0, "width": width, "height": height}
    stream.update(_H264_8BIT if video_stream is None else video_stream)
    times = [0.0, 2.0, 4.0, 6.0, 8.0, 10.0] if keyframes is None else keyframes

    def run(cmd, **_kwargs):
        mock = MagicMock()
        mock.returncode = 0
        mock.stderr = ""
        mock.stdout = ""
        if cmd[0] == "ffprobe":
            entries = (
                cmd[cmd.index("-show_entries") + 1] if "-show_entries" in cmd else ""
            )
            selected = (
                cmd[cmd.index("-select_streams") + 1]
                if "-select_streams" in cmd else ""
            )
            if entries.startswith("packet="):
                # Sync samples, plus one ordinary frame so the "K" filter is
                # doing something rather than counting every packet.
                mock.stdout = json.dumps({"packets": [
                    *({"pts_time": f"{t:.6f}", "flags": "K_"} for t in times),
                    {"pts_time": "0.040000", "flags": "__"},
                ]})
            elif selected == "v:0":
                mock.stdout = json.dumps({"streams": [stream]})
            elif selected == "a":
                mock.stdout = json.dumps({"streams": audio_streams or []})
        elif "trace_headers" in cmd:
            # What ffmpeg -v trace really prints per NAL unit. An open-GOP
            # master has one real IDR and marks its later entry points with a
            # recovery point instead.
            #
            # The prefixes are the point, not decoration. `avformat_find_stream_info`
            # decodes enough to identify the stream and logs its own IDR line
            # from an `[h264 @ ...]` context before trace_headers runs, so real
            # output always carries exactly one more IDR line than there are
            # sync samples. Emitting bare lines hid that, which is why the test
            # below for a sync sample that is not an IDR could not fail (#377).
            # Measured against ffmpeg 7.1.5: 15 sync samples give 15
            # `[trace_headers @ ...]` IDR lines and 1 `[h264 @ ...]` one.
            if trace_silent:
                # ffmpeg exits 0 and prints nothing trace_headers shaped, which
                # is what a future change in its log spelling would look like.
                mock.stderr = "some other ffmpeg chatter\n"
                return mock
            th = "[trace_headers @ 0x7f8e0] "
            # `_copy_probe_windows` also samples the tail of a long master, and
            # `tail_open_gop` is how a joined source is modelled: the head looks
            # copyable and the part after the join does not (#379). The tail pass
            # is the one that seeks, so `-ss` identifies it.
            if tail_open_gop and "-ss" in cmd:
                mock.stderr = "\n".join(
                    ["[h264 @ 0x7f8e1] nal_unit_type: 5(IDR), nal_ref_idc: 3",
                     th + "nal_unit_type: 5(IDR), nal_ref_idc: 3"]
                    + [th + "recovery_frame_cnt        00000 = 0"] * (len(times) - 1))
                return mock
            lines = ["[h264 @ 0x7f8e1] nal_unit_type: 5(IDR), nal_ref_idc: 3",
                     th + "nal_unit_type: 7(SPS), nal_ref_idc: 3"]
            idr_units = len(times) if idrs is None else idrs
            if open_gop:
                idr_units = 1 if idrs is None else idrs
                lines += [th + "recovery_frame_cnt        00000 = 0"] * (len(times) - 1)
            lines += [th + "nal_unit_type: 5(IDR), nal_ref_idc: 3"] * idr_units
            mock.stderr = "\n".join(lines)
        elif remux_fails and "-f" in cmd and cmd[cmd.index("-f") + 1] == "hls" \
                and "copy" in cmd:
            mock.returncode = 1
            mock.stderr = "Invalid data found when processing input"
        return mock

    job = TranscodeJob(
        media_id="media-1", version_id="v1",
        input_s3_key="uploads/video.mp4", output_s3_prefix="hls/media-1/v1",
        qualities=qualities,
    )
    s3 = MagicMock()
    s3.generate_presigned_url.return_value = "https://s3.example.com/uploads/video.mp4"

    env = {k: v for k, v in os.environ.items() if k != "TRANSCODER_SOURCE_COPY"}
    if source_copy is not None:
        env["TRANSCODER_SOURCE_COPY"] = source_copy

    with patch.dict(os.environ, env, clear=True), \
         patch("subprocess.run", side_effect=run) as mock_run, \
         patch("builtins.open", MagicMock()), \
         patch("pathlib.Path.glob", return_value=[]), \
         patch("pathlib.Path.rglob", return_value=[]), \
         patch("pathlib.Path.mkdir"), \
         patch("shutil.rmtree"):
        result = asyncio.run(FFmpegTranscoder(s3, "test-bucket").transcode(job))
        commands = [c[0][0] for c in mock_run.call_args_list]

    hls = [c for c in commands if "-f" in c and c[c.index("-f") + 1] == "hls"]
    assert len(hls) == hls_commands, (
        f"expected {hls_commands} HLS command(s), got {len(hls)}"
    )
    return hls[0], result, commands


def _copies(cmd: list[str]) -> bool:
    return "-c:v" in cmd and cmd[cmd.index("-c:v") + 1] == "copy"


# ─────────────────────────────────── what may be copied

def test_a_browser_safe_source_at_the_ladder_s_size_is_remuxed():
    cmd, result, _ = _transcode(["1080p"], source=(1920, 1080))

    assert _copies(cmd)
    assert "-filter_complex" not in cmd, "a copy has nothing to filter"
    assert cmd[cmd.index("-var_stream_map") + 1] == "v:0"
    assert result.success and result.hls_prefix == "hls/media-1/v1"
    assert (result.width, result.height) == (1920, 1080)


def test_a_rung_above_the_source_copies_too():
    # `TRANSCODER_QUALITIES=1080p` on a 720p master: the ladder clamps the rung
    # to the source size, which is exactly the case this setting is for.
    cmd, _, _ = _transcode(["1080p"], source=(1280, 720))

    assert _copies(cmd)


def test_a_source_that_is_not_16_9_copies_at_its_own_size():
    # The rung is applied with force_original_aspect_ratio=decrease, so a
    # 1440x1080 master under `1920:1080` is scaled by exactly 1 and written out
    # at its own size -- the same rendition a copy would produce. Comparing the
    # nominal `w:h` strings instead read this as a rung to encode, which hid the
    # setting from every 4:3 and cinema-ratio master on the instance.
    for width, height in ((1440, 1080), (1920, 1080), (1920, 804)):
        cmd, _, _ = _transcode(["1080p"], source=(width, height))
        assert _copies(cmd), f"{width}x{height} resolves to its own size"

    # A source wider than the rung's box is a different thing and still encodes:
    # 1998x1080 does not fit inside 1920x1080, so the ladder really is being
    # asked for a smaller rendition.
    cmd, _, _ = _transcode(["1080p"], source=(1998, 1080))
    assert not _copies(cmd)


def test_the_copy_writes_the_master_playlist_both_routers_hand_out():
    # assets.py and share.py both point the player at master.m3u8, and ffmpeg
    # only writes one when it is asked to.
    cmd, _, _ = _transcode(["1080p"])

    assert cmd[cmd.index("-master_pl_name") + 1] == "master.m3u8"
    assert cmd[cmd.index("-f") + 1] == "hls"
    assert cmd[cmd.index("-hls_playlist_type") + 1] == "vod"
    assert cmd[cmd.index("-hls_segment_type") + 1] == "mpegts"


def test_nothing_is_copied_unless_the_deployment_asks():
    cmd, _, _ = _transcode(["1080p"], source=(1920, 1080), source_copy=None)

    assert not _copies(cmd)
    assert "-filter_complex" in cmd
    # and an unrecognised value is not an invitation either
    cmd, _, _ = _transcode(["1080p"], source=(1920, 1080), source_copy="maybe")
    assert not _copies(cmd)


# ─────────────────────────────────── what may not

def test_a_configured_ladder_still_gets_every_rung_it_asked_for():
    cmd, _, _ = _transcode(["1080p", "720p", "360p"], source=(1920, 1080))

    assert not _copies(cmd)
    assert "split=3" in cmd[cmd.index("-filter_complex") + 1]


def test_a_rung_below_the_source_is_encoded():
    # The reviewer asked for a smaller rendition than the master. Copying would
    # hand them the master instead, which is the setting overriding the ladder
    # rather than following it.
    cmd, _, _ = _transcode(["720p"], source=(1920, 1080))

    assert not _copies(cmd)
    assert "scale=1280:720" in cmd[cmd.index("-filter_complex") + 1]


def test_ten_bit_h264_is_encoded():
    # High 10 carries codec_name "h264" and plays in no browser. Checking the
    # codec name alone would copy it and the asset would be black for everyone.
    cmd, _, _ = _transcode(
        ["1080p"], video_stream={"codec_name": "h264", "pix_fmt": "yuv420p10le"},
    )

    assert not _copies(cmd)


def test_a_source_in_another_codec_is_encoded():
    for codec in ("prores", "hevc", "vp9", "mpeg2video"):
        cmd, _, _ = _transcode(
            ["1080p"], video_stream={"codec_name": codec, "pix_fmt": "yuv420p"},
        )
        assert not _copies(cmd), f"{codec} must not be copied"


def test_an_hdr_source_is_encoded():
    # 8-bit 4:2:0 with a PQ transfer is unusual but possible, and copying it
    # skips the tone-mapping the filter graph exists for.
    cmd, _, _ = _transcode(
        ["1080p"],
        video_stream={**_H264_8BIT, "color_transfer": "smpte2084"},
    )

    assert not _copies(cmd)


def test_a_rotated_source_is_encoded():
    # A portrait clip off a phone is H.264 8-bit 4:2:0 SDR at its own size and
    # passes every other condition. The orientation is a display matrix in the
    # container, MPEG-TS cannot carry one, and the encode path only gets it
    # right because a filter graph makes ffmpeg autorotate -- so a copy would
    # produce a video lying on its side beside an upright thumbnail.
    for rotation in (90, -90, 180, 270):
        cmd, _, _ = _transcode(["1080p"], video_stream={
            **_H264_8BIT,
            "side_data_list": [
                {"side_data_type": "Display Matrix", "rotation": rotation},
            ],
        })
        assert not _copies(cmd), f"rotation {rotation} must not be copied"

    # the older spelling of the same thing
    cmd, _, _ = _transcode(
        ["1080p"], video_stream={**_H264_8BIT, "tags": {"rotate": "90"}},
    )
    assert not _copies(cmd)


def test_an_upright_source_is_not_mistaken_for_a_rotated_one():
    # Side data is where rotation lives, but it is not only rotation that lives
    # there, and a zero rotation is not a rotation.
    cmd, _, _ = _transcode(["1080p"], video_stream={
        **_H264_8BIT,
        "side_data_list": [
            {"side_data_type": "Display Matrix", "rotation": 0},
        ],
    })
    assert _copies(cmd)

    cmd, _, _ = _transcode(["1080p"], video_stream={
        **_H264_8BIT,
        "side_data_list": [{"side_data_type": "Content Light Level"}],
    })
    assert _copies(cmd)


def test_an_open_gop_source_is_encoded():
    # Its later sync samples are recovery points rather than IDRs, so a segment
    # beginning at one carries no parameter sets and no clean decode point.
    # Nothing about this fails loudly: playback from the top works and the job
    # succeeds. Seeking is what breaks, and seeking is what a review tool is.
    cmd, _, _ = _transcode(["1080p"], open_gop=True)

    assert not _copies(cmd)


def test_an_open_gop_source_is_encoded_even_when_the_idr_count_looks_healthy():
    # A frame split into several slices produces one IDR NAL per slice, so a
    # master with a single real IDR frame can still out-count its sync samples.
    # The recovery points are what say what this stream is, and they are why
    # counting IDRs is not the whole answer.
    cmd, _, _ = _transcode(["1080p"], open_gop=True, idrs=8)

    assert not _copies(cmd)


def test_a_sync_sample_that_is_not_an_idr_is_encoded_without_a_recovery_point():
    # The recovery-point SEI is how an open-GOP encoder announces itself, but it
    # is a courtesy rather than a requirement. Counting IDRs against sync
    # samples is what actually answers the question, so it is checked even when
    # nothing announced anything.
    cmd, _, _ = _transcode(["1080p"], keyframes=[0.0, 2.0, 4.0], idrs=1)

    assert not _copies(cmd)


def test_exactly_one_sync_sample_that_is_not_an_idr_is_still_encoded(  # noqa: E501
):
    # The off-by-one (#377). Real `ffmpeg -v trace` prints one
    # `nal_unit_type: 5(IDR)` line from its own `[h264 @ ...]` decode context
    # before trace_headers runs, so counting every occurrence came out exactly
    # one high and the backstop tolerated exactly one bad sync sample. The
    # sibling test above uses a margin of two, where an off-by-one cannot show.
    cmd, _, _ = _transcode(["1080p"], keyframes=[0.0, 2.0, 4.0], idrs=2)

    assert not _copies(cmd)


def test_keyframes_that_stop_after_the_start_are_encoded():
    # The gap running off the end of the window (#378). Taking only the pairwise
    # gaps measures the distance between sync samples and never the distance
    # after the last one, so a slate spliced onto a long-GOP body reported half
    # a second and copied into one segment as long as the file. Measured on a
    # real 41s file built that way: the copy produced a single `#EXTINF:41`.
    cmd, _, _ = _transcode(
        ["1080p"], keyframes=[0.0, 0.5, 1.0],
        video_stream={**_H264_8BIT, "duration": 41.0},
    )

    assert not _copies(cmd)


def test_a_master_that_changes_after_the_first_window_is_encoded():
    # The bound on the probe (#379). One window says what the first 30s look
    # like, not what the file is, and a lossless join of clips from different
    # encoders breaks that premise: reproduced on a real joined file whose head
    # is closed-GOP and whose tail is not, where segments 18 onward each decode
    # to `non-existing PPS 0 referenced` while ffmpeg exits 0.
    # Keyframes run the length of the head window on purpose: without them the
    # tail-gap rule above refuses first and this passes for the wrong reason.
    cmd, _, _ = _transcode(
        ["1080p"], tail_open_gop=True,
        keyframes=[float(t) for t in range(0, 32, 2)],
        video_stream={**_H264_8BIT, "duration": 55.0},
    )

    assert not _copies(cmd)


def test_a_trace_that_says_nothing_is_encoded_and_says_why(capsys):
    # The gate rests on parsing ffmpeg's log, which is not an interface ffmpeg
    # promises to keep. If trace_headers says nothing at all the parse did not
    # happen, whatever the exit code claims (#381).
    #
    # The refusal itself is not what this pins: with no trace output every count
    # is zero, so the IDR backstop below already refuses. What the guard adds is
    # the REASON, and the reason is the operator's only signal for why a copy
    # they enabled is encoding instead. Asserting the message rather than the
    # verdict is what makes this a test rather than a restatement of the
    # backstop.
    capsys.readouterr()
    cmd, _, _ = _transcode(["1080p"], trace_silent=True)

    assert not _copies(cmd)
    assert "produced no trace output" in capsys.readouterr().out


def test_a_short_master_is_not_refused_for_silence_past_its_end():
    # The guard on the tail-gap fix: the window is 30s and this file is 6s, so
    # 24s of it are past the end of the media. Clamping to the real duration is
    # what stops that being read as a 24s stretch with no sync sample.
    cmd, _, _ = _transcode(["1080p"], keyframes=[0.0, 2.0, 4.0])

    assert _copies(cmd)


def test_a_source_whose_keyframes_are_too_far_apart_is_encoded():
    # `-hls_time` is a floor for a copy, so the master's own spacing decides
    # segment length. 20s apart would mean 20s segments.
    cmd, _, _ = _transcode(["1080p"], keyframes=[0.0, 20.0])

    assert not _copies(cmd)


def test_a_source_with_one_sync_sample_in_the_window_is_encoded():
    # One keyframe in the probe window means the second is somewhere past it,
    # which is both an unbounded segment and a keyframe structure we did not
    # get to look at. Refused rather than guessed at.
    cmd, _, _ = _transcode(["1080p"], keyframes=[0.0])

    assert not _copies(cmd)


def test_a_probe_that_says_nothing_useful_is_encoded():
    # Every refusal costs encode time; the other direction costs an asset
    # nobody can seek in. So an empty or unreadable probe encodes.
    cmd, _, _ = _transcode(["1080p"], keyframes=[])

    assert not _copies(cmd)


def test_a_source_of_unknown_size_is_encoded():
    # Without dimensions there is nothing to compare the rung against, so the
    # "one rendition at source size" precondition cannot be established.
    cmd, _, _ = _transcode(["1080p"], source=(0, 0))

    assert not _copies(cmd)


# ─────────────────────────────────── audio, and what a copy does not produce

def test_aac_rides_along_and_anything_else_is_converted():
    cmd, _, _ = _transcode(["1080p"], audio_streams=[{"codec_name": "aac"}])
    assert cmd[cmd.index("-c:a") + 1] == "copy"
    assert cmd[cmd.index("-var_stream_map") + 1] == "v:0,a:0"

    # PCM is what an NLE exports and HLS cannot carry it. Converting costs
    # seconds and leaves the picture untouched, which is the point.
    cmd, _, _ = _transcode(["1080p"], audio_streams=[{"codec_name": "pcm_s16le"}])
    assert cmd[cmd.index("-c:a") + 1] == "aac"
    assert _copies(cmd)


def test_a_silent_source_maps_no_audio():
    cmd, _, _ = _transcode(["1080p"], audio_streams=[])

    assert "-c:a" not in cmd
    assert cmd.count("-map") == 1
    assert cmd[cmd.index("-var_stream_map") + 1] == "v:0"


def test_a_copied_source_writes_no_second_file_to_download():
    # The rendition is the uploaded stream, so the master the download falls
    # back to is the same picture: a download MP4 would be a third copy of it.
    _, result, commands = _transcode(["1080p"], source=(1920, 1080))

    assert result.mp4_key is None
    assert not [c for c in commands if any(str(a).endswith("download.mp4") for a in c)]

    # ... while an encoded ladder still gets one, or this test would pass on a
    # transcoder that had stopped building them at all.
    _, result, commands = _transcode(["1080p"], source=(1920, 1080), source_copy=None)
    assert result.mp4_key == "hls/media-1/v1/download.mp4"


# ─────────────────────────────────── when the remux itself fails

def test_a_failed_remux_is_encoded_rather_than_failed():
    # A copy has no hardware to degrade from, but it can fail on things
    # specific to remuxing that an encode absorbs. The setting exists to make a
    # transcode cheaper, not to add a way for one to fail.
    cmd, result, commands = _transcode(
        ["1080p"], remux_fails=True, hls_commands=2,
    )

    assert _copies(cmd), "the copy is still what is tried first"
    encoded = [c for c in commands
               if "-f" in c and c[c.index("-f") + 1] == "hls" and not _copies(c)]
    assert len(encoded) == 1 and "-filter_complex" in encoded[0]
    assert result.success

    # and the ladder it fell back to is an ordinary one, so it wants the
    # download rung like any other
    assert result.mp4_key == "hls/media-1/v1/download.mp4"
