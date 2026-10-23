"""A portrait phone clip comes out upright on a GPU backend too.

A phone records portrait video as landscape pixels plus a display matrix that
tells the player to turn them. ffmpeg turns them upright before the filter graph
(autorotate) -- but only for frames in system memory. It skips hardware frames,
so with `-hwaccel cuda -hwaccel_output_format cuda` a clip stored 1920x1080 with
a 90-degree matrix came out as 1920x1080 landscape rungs lying on their side,
and MPEG-TS has nowhere to carry the matrix, so nothing downstream could undo
it. The thumbnail, made in software, was upright. Measured on ffmpeg 7.1.5 with
an RTX 5070 Ti; VAAPI and QSV frames are hardware frames too.

On NVENC such a source now keeps NVDEC but decodes into system memory, so
ffmpeg's own autorotate turns it, and is uploaded for the GPU scale and encode.
On VAAPI, which nobody can test here, it starts on the CPU-decode tier instead.
"""
import asyncio
import json
import re
from unittest.mock import MagicMock, patch

import pytest

from packages.transcoder.base import TranscodeJob
from packages.transcoder.ffmpeg_transcoder import (
    FFmpegTranscoder,
    _plan_attempts,
    display_rotation,
    is_display_transformed,
)

PRESIGNED = "https://s3.example.com/uploads/phone.mov?X-Amz-Signature=secret"
KEY = "uploads/phone.mov"

H264 = {"codec_name": "h264", "pix_fmt": "yuv420p"}
HEVC = {"codec_name": "hevc", "pix_fmt": "yuv420p"}
PRORES = {"codec_name": "prores", "pix_fmt": "yuv422p10le"}


def _matrix(rotation):
    return {"side_data_list": [{"side_data_type": "Display Matrix", "rotation": rotation}]}


# What ffprobe 7.1.5 reports for -display_rotation 90 / 270 / 180, and for
# -display_vflip, which turns the picture without any rotation to show for it.
ROTATED_90 = _matrix(90)
ROTATED_270 = _matrix(-90)
ROTATED_180 = _matrix(-180)
VFLIP = _matrix(0)

NVDEC_REFUSAL = "Failed setup for format cuda: hwaccel initialisation returned error."
NVENC_BELOW_MINIMUM = (
    "[h264_nvenc @ 0x555579ed1a40] InitializeEncoder failed: invalid param (8): "
    "Frame Dimension less than the minimum supported value.\n"
    "Conversion failed!"
)


def _transcode(stream, backend="nvenc", width=1920, height=1080, failures=None,
               qualities=("1080p", "720p", "360p")):
    """Run a mocked transcode; return (result, ffmpeg encode commands in order)."""
    failures = failures or []
    calls: list[list[str]] = []

    def run(cmd, **_kwargs):
        if "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "V:0":
            probed = {"r_frame_rate": "30/1", "duration": 6.0, **H264,
                      "width": width, "height": height, **stream}
            return MagicMock(returncode=0, stderr="",
                             stdout=json.dumps({"streams": [probed]}))
        if "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "a":
            return MagicMock(returncode=0, stderr="", stdout=json.dumps({"streams": []}))
        if any("filter_complex" in str(a) for a in cmd):
            calls.append(cmd)
            if len(calls) <= len(failures):
                return MagicMock(returncode=1, stderr=failures[len(calls) - 1], stdout="")
        return MagicMock(returncode=0, stderr="", stdout="")

    job = TranscodeJob(
        media_id="media-1", version_id="v1", input_s3_key=KEY,
        output_s3_prefix="hls/media-1/v1", qualities=list(qualities),
    )
    s3 = MagicMock()
    s3.generate_presigned_url.return_value = PRESIGNED
    with patch("subprocess.run", side_effect=run), \
         patch("packages.transcoder.ffmpeg_transcoder.get_backend", return_value=backend), \
         patch("builtins.open", MagicMock()), \
         patch("pathlib.Path.glob", return_value=[]), \
         patch("pathlib.Path.rglob", return_value=[]), \
         patch("pathlib.Path.mkdir"), \
         patch("shutil.rmtree"):
        result = asyncio.run(FFmpegTranscoder(s3, "test-bucket").transcode(job))
    return result, calls


def _graph(cmd):
    return cmd[cmd.index("-filter_complex") + 1]


def _global_args(cmd):
    """What comes before -i: the decode the command asks for."""
    return cmd[2:cmd.index("-i")]


def _boxes(cmd):
    return dict((q, box) for box, q in
                re.findall(r"scale(?:_\w+)?=(\d+:\d+):[^\[]*\[(\w+)\]", _graph(cmd)))


def _decodes_into_memory_on_nvdec(cmd):
    """NVDEC decode whose frames reach the graph in system memory, then go up."""
    return (_global_args(cmd) == ["-hwaccel", "cuda"]
            and _graph(cmd).startswith("[0:V:0]copy,hwupload_cuda[up];[up]split=")
            and "scale_cuda" in _graph(cmd))


def _is_software(cmd):
    joined = " ".join(cmd)
    return ("-hwaccel" not in joined and "cuda" not in joined
            and "vaapi" not in joined and "libx264" in joined)


# ── which sources ffmpeg turns ────────────────────────────────────────────────

@pytest.mark.parametrize("stream, expected", [
    (ROTATED_90, True),
    (ROTATED_270, True),
    (ROTATED_180, True),
    # A flip has no rotation to show for it, and ffmpeg still turns the frames.
    (VFLIP, True),
    ({"tags": {"rotate": "90"}}, True),
    # A rotation nobody can read may still be one, so the frames go the way
    # that turns them (#380).
    ({"tags": {"rotate": "abc"}}, True),
    ({"tags": {"rotate": "nan"}}, True),
    ({}, False),
    ({"tags": {"rotate": "0"}}, False),
    ({"side_data_list": [{"side_data_type": "Content Light Level"}]}, False),
    ({"side_data_list": [{"side_data_type": "DOVI configuration record", "dv_profile": 8}]},
     False),
])
def test_a_display_matrix_is_what_ffmpeg_turns_the_frames_for(stream, expected):
    assert is_display_transformed(stream) is expected


@pytest.mark.parametrize("rotate", ["nan", "inf", "-inf", "abc"])
def test_a_rotation_that_cannot_be_read_is_never_a_nan(rotate):
    # float() accepts "nan" and "inf", and `% 360` keeps them NaN, which the
    # NVENC sizing then hands to round(). What the copy gate needs from such a
    # value is rotation_unreadable(), not a number (#380).
    assert display_rotation({"tags": {"rotate": rotate}}) == 0.0


def test_a_rotate_tag_of_nan_still_builds_an_nvenc_command():
    # round(nan) raised ValueError while sizing the rungs, failing the job.
    result, calls = _transcode({**H264, "tags": {"rotate": "nan"}})

    assert result.success is True
    assert len(calls) == 1
    assert _decodes_into_memory_on_nvdec(calls[0]), calls[0]
    assert _boxes(calls[0]) == {"1080p": "1920:1080", "720p": "1280:720", "360p": "640:360"}


@pytest.mark.parametrize("primary, encode, stream, expected", [
    # NVENC keeps its GPU-decode tier: it decodes into memory for these.
    ("nvenc", "nvenc", {**H264, **ROTATED_90},
     [("nvenc", True), ("nvenc", False), ("cpu", False)]),
    # VAAPI has no such path that anyone has tested, so it starts on the CPU.
    ("vaapi", "vaapi", {**H264, **ROTATED_90}, [("vaapi", False), ("cpu", False)]),
    ("vaapi", "vaapi", H264, [("vaapi", True), ("vaapi", False), ("cpu", False)]),
    ("copy", "vaapi", {**H264, **VFLIP}, [("copy", False), ("vaapi", False), ("cpu", False)]),
])
def test_the_attempt_ladder_for_a_rotated_source(primary, encode, stream, expected):
    assert _plan_attempts(primary, encode, stream, False) == expected


# ── NVENC: NVDEC decodes into system memory, ffmpeg turns the frames ─────────

@pytest.mark.parametrize("matrix", [ROTATED_90, ROTATED_270, ROTATED_180, VFLIP],
                         ids=["90", "270", "180", "vflip"])
@pytest.mark.parametrize("codec", [H264, HEVC], ids=["h264", "hevc"])
def test_a_rotated_source_on_nvenc_is_decoded_into_memory(codec, matrix):
    result, calls = _transcode({**codec, **matrix})

    assert result.success is True
    assert len(calls) == 1
    assert _decodes_into_memory_on_nvdec(calls[0]), calls[0]
    assert "-hwaccel_output_format" not in calls[0]
    assert "h264_nvenc" in calls[0]


def test_the_upload_is_handed_the_decoders_own_format(monkeypatch):
    # No CPU format conversion ahead of the upload: NVDEC hands over nv12 or
    # p010 already, and scale_cuda sets the encoder's depth. Converting 8-bit
    # 4K to p010 on the CPU first made the whole job cost four times the CPU.
    monkeypatch.setenv("TRANSCODER_OUTPUT", "h265_10")
    _, calls = _transcode({**HEVC, **ROTATED_90})

    graph = _graph(calls[0])
    assert "format=" not in graph.split("[up]")[0]
    assert ":format=p010" in graph
    assert "hevc_nvenc" in calls[0]


def test_an_unrotated_source_on_nvenc_keeps_its_cuda_frames():
    for stream in (H264, HEVC, {**H264, "side_data_list": [{"side_data_type": "Content Light Level"}]}):
        _, calls = _transcode(stream)
        assert _global_args(calls[0]) == ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
        assert _graph(calls[0]).startswith("[0:V:0]split=3")
        assert "hwupload" not in _graph(calls[0]) and "copy" not in _graph(calls[0])


def test_a_portrait_rotated_clip_gets_portrait_rungs_on_nvenc():
    # 1920x1080 stored, displayed 1080x1920. The scaler is handed the upright
    # frame, and the boxes are turned to match it (#452).
    _, calls = _transcode({**H264, **ROTATED_90})

    assert _boxes(calls[0]) == {"1080p": "1080:1920", "720p": "720:1280", "360p": "360:640"}
    assert _decodes_into_memory_on_nvdec(calls[0])


def test_a_narrow_rotated_clip_is_sized_upright_on_the_first_attempt():
    # 1920x400 with a 90-degree matrix is 400x1920 upright, whose 360p fit
    # (134x640) is under h264_nvenc's minimum, so the box is enlarged on the
    # NVDEC attempt as it already was on the CPU-decode one.
    result, calls = _transcode({**H264, **ROTATED_90}, width=1920, height=400,
                               failures=[NVDEC_REFUSAL])

    assert result.success is True
    nvdec, cpu_decode = calls
    assert _decodes_into_memory_on_nvdec(nvdec)
    assert _boxes(nvdec) == {"360p": "146:702"}
    assert "-hwaccel" not in cpu_decode
    assert _graph(cpu_decode).startswith("[0:V:0]format=nv12,hwupload_cuda[up];")
    assert _boxes(cpu_decode) == {"360p": "146:702"}


def test_a_hardware_frame_is_sized_as_it_is_stored():
    # QSV decodes a rotated source into hardware frames, which ffmpeg does not
    # turn, so its scaler is handed 1920x1080 and the boxes stay landscape.
    _, calls = _transcode({**H264, **ROTATED_90}, backend="qsv")

    assert "-hwaccel_output_format" in calls[0]
    assert _boxes(calls[0]) == {"1080p": "1920:1080", "720p": "1280:720", "360p": "640:360"}


def test_a_flip_does_not_swap_the_sizing():
    _, calls = _transcode({**H264, **VFLIP}, width=1920, height=720)

    assert _boxes(calls[0]) == {"720p": "1280:720", "360p": "640:360"}


def test_a_rotated_hdr_source_on_nvenc_is_tone_mapped_from_memory():
    # The HDR graph used to download the CUDA frame itself (hwdownload), after
    # the point where ffmpeg would have turned it.
    _, calls = _transcode({**HEVC, "pix_fmt": "yuv420p10le",
                           "color_transfer": "smpte2084", **ROTATED_90})

    cmd = calls[0]
    assert _global_args(cmd) == ["-hwaccel", "cuda"]
    graph = _graph(cmd)
    assert graph.startswith("[0:V:0]copy,format=p010,zscale"), graph
    assert "hwdownload" not in graph
    assert "[tcpu]hwupload_cuda[t]" in graph


def test_a_rotated_source_whose_nvdec_refuses_falls_to_the_cpu_decode_then_software():
    result, calls = _transcode({**H264, **ROTATED_90},
                               failures=[NVDEC_REFUSAL, "Error while filtering"])

    assert result.success is True
    assert len(calls) == 3
    assert _decodes_into_memory_on_nvdec(calls[0])
    assert "-hwaccel" not in calls[1] and "hwupload_cuda" in _graph(calls[1])
    assert _is_software(calls[2])


def test_an_encoder_nvenc_refuses_skips_the_cpu_decode_for_a_rotated_source():
    result, calls = _transcode({**H264, **ROTATED_90}, failures=[NVENC_BELOW_MINIMUM])

    assert result.success is True
    assert len(calls) == 2
    assert _decodes_into_memory_on_nvdec(calls[0])
    assert _is_software(calls[1])


def test_a_rotated_source_the_gpu_cannot_decode_keeps_the_cpu_decode():
    _, calls = _transcode({**PRORES, **ROTATED_90})

    assert "-hwaccel" not in calls[0]
    assert _graph(calls[0]).startswith("[0:V:0]format=nv12,hwupload_cuda[up];")


def test_the_log_says_why_a_rotated_source_is_decoded_into_memory(capsys):
    _transcode({**H264, **ROTATED_90})

    out = capsys.readouterr().out
    assert KEY in out and "display matrix" in out
    assert "X-Amz-Signature" not in out


# ── VAAPI: the CPU-decode tier, which autorotates in software ────────────────

def test_a_rotated_source_on_vaapi_is_decoded_on_the_cpu():
    result, calls = _transcode({**H264, **ROTATED_90}, backend="vaapi")

    assert result.success is True
    cmd = calls[0]
    assert "-hwaccel" not in cmd
    assert cmd[cmd.index("-vaapi_device") + 1] == "/dev/dri/renderD128"
    assert _graph(cmd).startswith("[0:V:0]format=nv12,hwupload[up];")
    assert "scale_vaapi" in _graph(cmd)


def test_an_unrotated_source_on_vaapi_keeps_its_hardware_decode():
    _, calls = _transcode(H264, backend="vaapi")

    assert _global_args(calls[0])[:2] == ["-hwaccel", "vaapi"]


# ── unchanged ─────────────────────────────────────────────────────────────────

def test_the_software_backend_is_unchanged_for_a_rotated_source():
    _, calls = _transcode({**H264, **ROTATED_90}, backend="cpu")

    assert _global_args(calls[0]) == []
    assert _graph(calls[0]).startswith("[0:V:0]split=3")
    assert "libx264" in calls[0]
