"""A source the GPU can encode but not decode is decoded on the CPU.

NVDEC and Intel VAAPI cannot decode ProRes, nor H.264 10-bit or 4:2:2. With
`-hwaccel cuda -hwaccel_output_format cuda` on such a source, ffmpeg falls back
to a software decode without saying so, hands the frames to `scale_cuda`, and
filter setup fails with "Function not implemented". The job then went to the
all-software pipeline, so a ProRes master never touched the GPU at all.

Now those sources start on a middle tier -- CPU decode, frames uploaded, GPU
scale and encode -- and every hardware chain still ends on the software
pipeline. Sources the GPU does decode keep the exact command they had.
"""
import asyncio
import json
from unittest.mock import MagicMock, patch

import pytest

from packages.transcoder.base import TranscodeJob
from packages.transcoder.ffmpeg_transcoder import (
    FFmpegTranscoder,
    _gpu_can_decode,
    _is_gpu_decode_failure,
    _plan_attempts,
)

PRESIGNED = "https://s3.example.com/uploads/video.mov?X-Amz-Signature=secret"
KEY = "uploads/video.mov"

PRORES = {"codec_name": "prores", "pix_fmt": "yuv422p10le"}
H264 = {"codec_name": "h264", "pix_fmt": "yuv420p"}
DOLBY_VISION_5 = {
    "codec_name": "hevc", "pix_fmt": "yuv420p10le",
    "side_data_list": [
        {"side_data_type": "DOVI configuration record", "dv_profile": 5},
    ],
}

DECODE_FAILURE = (
    "Impossible to convert between the formats supported by the filter "
    "'graph 0 input from stream 0:0' and the filter 'auto_scale_0'\n"
    "Failed to inject frame into filter network: Function not implemented"
)
# What a real NVDEC refusal prints, with no scale_cuda complaint after it.
NVDEC_REFUSAL = "Failed setup for format cuda: hwaccel initialisation returned error."
# hwupload_cuda with no usable CUDA device (CUDA_VISIBLE_DEVICES=-1, a GPU off the
# bus, a driver upgraded without a reboot) while nvidia-smi still lists the card.
NO_DEVICE = (
    "cu->cuInit(0) failed -> CUDA_ERROR_NO_DEVICE: no CUDA-capable device is detected\n"
    "[AVFilterGraph] Error initializing filters\n"
    "Failed to set value '[0:V:0]format=nv12,hwupload_cuda[up];[up]split=2' for option "
    "'filter_complex': Generic error in an external library"
)
NVENC_TOO_SHORT = (
    "[h264_nvenc] InitializeEncoder failed: invalid param (8): "
    "Frame Dimension less than the minimum supported value."
)


def _transcode(video_stream: dict, backend: str, failures: list[str] | None = None):
    """Run a mocked transcode and return (result, ffmpeg commands in order).

    `failures[i]` is the stderr the i-th ffmpeg attempt exits with; attempts past
    the end of the list succeed.
    """
    failures = failures or []
    calls: list[list[str]] = []

    def run(cmd, **_kwargs):
        if "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "V:0":
            stream = {"r_frame_rate": "25/1", "duration": 6.0,
                      "width": 1920, "height": 1080, **video_stream}
            return MagicMock(returncode=0, stderr="",
                             stdout=json.dumps({"streams": [stream]}))
        if "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "a":
            return MagicMock(returncode=0, stderr="", stdout=json.dumps({"streams": []}))
        if any("filter_complex" in str(a) for a in cmd):
            calls.append(cmd)
            if len(calls) <= len(failures):
                return MagicMock(returncode=1, stderr=failures[len(calls) - 1], stdout="")
        return MagicMock(returncode=0, stderr="", stdout="")

    job = TranscodeJob(
        media_id="media-1", version_id="v1", input_s3_key=KEY,
        output_s3_prefix="hls/media-1/v1", qualities=["1080p", "720p"],
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


def _filter(cmd: list[str]) -> str:
    return cmd[cmd.index("-filter_complex") + 1]


def _is_software(cmd: list[str]) -> bool:
    joined = " ".join(cmd)
    return ("-hwaccel" not in joined and "cuda" not in joined
            and "vaapi" not in joined and "libx264" in joined)


# ── the prediction ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("stream, expected", [
    (PRORES, False),
    ({"codec_name": "prores", "pix_fmt": "yuva444p10le"}, False),  # 4444
    ({"codec_name": "dnxhd", "pix_fmt": "yuv422p10le"}, False),
    (H264, True),
    ({"codec_name": "h264", "pix_fmt": "yuvj420p"}, True),
    ({"codec_name": "h264", "pix_fmt": "yuv420p10le"}, False),     # High 10
    ({"codec_name": "h264", "pix_fmt": "yuv422p"}, False),         # High 4:2:2
    ({"codec_name": "hevc", "pix_fmt": "yuv420p10le"}, True),
    ({"codec_name": "hevc", "pix_fmt": "yuvj420p"}, True),
    ({"codec_name": "hevc", "pix_fmt": "yuv420p12le"}, True),
    ({"codec_name": "hevc", "pix_fmt": "yuv444p"}, True),
    ({"codec_name": "hevc", "pix_fmt": "yuv444p10le"}, True),
    ({"codec_name": "hevc", "pix_fmt": "yuv422p10le"}, False),
    ({"codec_name": "vp9", "pix_fmt": "yuv420p"}, True),
    ({"codec_name": "vp9", "pix_fmt": "yuv420p10le"}, True),
    ({"codec_name": "vp9", "pix_fmt": "yuv420p12le"}, True),
    ({"codec_name": "vp9", "pix_fmt": "yuv444p"}, False),
    ({"codec_name": "vp8", "pix_fmt": "yuv420p"}, True),
    ({"codec_name": "av1", "pix_fmt": "yuv420p"}, True),
    ({"codec_name": "av1", "pix_fmt": "yuv420p10le"}, True),
    ({"codec_name": "mpeg2video", "pix_fmt": "yuv420p"}, True),
    ({"codec_name": "mpeg2video", "pix_fmt": "yuv422p"}, False),
    ({"codec_name": "mpeg4", "pix_fmt": "yuv420p"}, True),
    ({"codec_name": "h264", "pix_fmt": "yuv444p"}, False),
    ({"codec_name": "theora", "pix_fmt": "yuv420p"}, False),       # not in the table
], ids=lambda v: v if isinstance(v, bool) else f"{v['codec_name']}-{v['pix_fmt']}")
def test_the_gpu_decoders_are_predicted_by_codec_and_pixel_format(stream, expected):
    assert _gpu_can_decode("nvenc", stream) is expected
    assert _gpu_can_decode("vaapi", stream) is expected


def test_only_a_missing_codec_or_an_upload_less_backend_keeps_the_hardware_decode():
    # Nothing to decide on, so nothing changes: the command stays the one the
    # backend always built.
    assert _gpu_can_decode("nvenc", {}) is True
    assert _gpu_can_decode("qsv", PRORES) is True
    # A codec with no pixel format could be anything; the CPU decode takes it all.
    assert _gpu_can_decode("nvenc", {"codec_name": "h264"}) is False


@pytest.mark.parametrize("primary, encode, stream, dv, expected", [
    ("nvenc", "nvenc", H264, False,
     [("nvenc", True), ("nvenc", False), ("cpu", False)]),
    ("nvenc", "nvenc", PRORES, False, [("nvenc", False), ("cpu", False)]),
    ("vaapi", "vaapi", PRORES, False, [("vaapi", False), ("cpu", False)]),
    ("qsv", "qsv", PRORES, False, [("qsv", True), ("cpu", False)]),
    ("cpu", "cpu", PRORES, False, [("cpu", False)]),
    ("nvenc", "nvenc", DOLBY_VISION_5, True, [("nvenc", False)]),
    ("copy", "nvenc", H264, False,
     [("copy", False), ("nvenc", True), ("nvenc", False), ("cpu", False)]),
    ("copy", "cpu", H264, False, [("copy", False), ("cpu", False)]),
])
def test_every_hardware_ladder_ends_on_software(primary, encode, stream, dv, expected):
    assert _plan_attempts(primary, encode, stream, dv) == expected


def test_out_of_memory_is_not_a_decoder_problem():
    # NVDEC logs this pair when VRAM is exhausted. The encoder needs VRAM too,
    # so it must not route to the CPU-decode tier.
    assert not _is_gpu_decode_failure(
        "cuvidCreateDecoder failed -> CUDA_ERROR_OUT_OF_MEMORY: out of memory\n"
        "Failed setup for format cuda: hwaccel initialisation returned error.")
    assert _is_gpu_decode_failure(DECODE_FAILURE)


@pytest.mark.parametrize("stderr", [
    NVDEC_REFUSAL,
    "Failed setup for format cuda",
    "hwaccel initialisation returned error",
])
def test_an_nvdec_refusal_is_a_decoder_problem(stderr):
    assert _is_gpu_decode_failure(stderr)


def test_a_missing_device_is_not_a_decoder_problem():
    # The CPU-decode tier would open the same missing device.
    assert not _is_gpu_decode_failure(NO_DEVICE)


# ── the commands ──────────────────────────────────────────────────────────────

def test_prores_on_nvenc_decodes_on_the_cpu_and_encodes_on_the_gpu():
    result, calls = _transcode(PRORES, "nvenc")

    assert result.success is True
    assert len(calls) == 1, "a known-undecodable source must not try the GPU decoder first"
    cmd = calls[0]
    assert "-hwaccel" not in cmd and "-hwaccel_output_format" not in cmd
    assert _filter(cmd).startswith("[0:V:0]format=nv12,hwupload_cuda[up];[up]split=2")
    assert "scale_cuda" in _filter(cmd)
    assert "h264_nvenc" in cmd


def test_ten_bit_output_uploads_ten_bit_frames(monkeypatch):
    monkeypatch.setenv("TRANSCODER_OUTPUT", "h265_10")
    _, calls = _transcode(PRORES, "nvenc")

    assert _filter(calls[0]).startswith("[0:V:0]format=p010,hwupload_cuda[up];")
    assert "hevc_nvenc" in calls[0]


@pytest.mark.parametrize("backend, upload", [
    ("nvenc", "[tcpu]hwupload_cuda[t]"),
    ("vaapi", "[tcpu]hwupload[t]"),
])
def test_hdr_from_a_cpu_decode_is_not_downloaded_from_the_gpu(backend, upload):
    # The frame is already in system memory; `hwdownload` on it fails.
    _, calls = _transcode({**PRORES, "color_transfer": "smpte2084"}, backend)

    cmd = calls[0]
    graph = _filter(cmd)
    assert graph.startswith("[0:V:0]format=p010,zscale"), graph
    assert "hwdownload" not in graph
    assert upload in graph
    assert "-hwaccel" not in cmd
    if backend == "vaapi":
        # hwupload has no device of its own; -vaapi_device is the one it uses.
        assert cmd.index("-vaapi_device") < cmd.index("-i")


def test_hdr_from_a_gpu_decode_is_unchanged():
    _, calls = _transcode({**H264, "color_transfer": "smpte2084"}, "nvenc")

    assert _filter(calls[0]).startswith("[0:V:0]hwdownload,format=p010")
    assert calls[0][2:6] == ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]


def test_prores_on_vaapi_uploads_to_the_vaapi_device():
    _, calls = _transcode(PRORES, "vaapi")

    cmd = calls[0]
    assert "-hwaccel" not in cmd
    assert cmd[cmd.index("-vaapi_device") + 1] == "/dev/dri/renderD128"
    assert cmd.index("-vaapi_device") < cmd.index("-i")
    assert _filter(cmd).startswith("[0:V:0]format=nv12,hwupload[up];")
    assert "scale_vaapi" in _filter(cmd)
    assert "h264_vaapi" in cmd


def test_a_gpu_decodable_source_keeps_its_command():
    _, calls = _transcode(H264, "nvenc")

    assert len(calls) == 1
    assert calls[0][2:6] == ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
    assert _filter(calls[0]).startswith("[0:V:0]split=2")
    assert "hwupload" not in _filter(calls[0])


def test_dolby_vision_5_stays_on_its_single_software_attempt():
    _, calls = _transcode(DOLBY_VISION_5, "nvenc")

    assert len(calls) == 1
    assert _filter(calls[0]).startswith("[0:V:0]libplacebo=")
    assert "hwupload" not in _filter(calls[0])
    assert "-hwaccel" not in calls[0]


# ── the fallbacks ─────────────────────────────────────────────────────────────

def test_a_cpu_decode_attempt_that_cannot_reach_the_encoder_falls_back_to_software():
    result, calls = _transcode(
        PRORES, "nvenc", failures=["[h264_nvenc] Cannot load libnvidia-encode.so.1"])

    assert result.success is True
    assert len(calls) == 2
    assert "hwupload_cuda" in _filter(calls[0])
    assert _is_software(calls[1]), calls[1]


def test_a_wrong_prediction_is_retried_with_the_cpu_decode():
    # H.264 4:2:0 on a GPU whose NVDEC still refuses it (too large, say).
    result, calls = _transcode(H264, "nvenc", failures=[DECODE_FAILURE])

    assert result.success is True
    assert len(calls) == 2
    assert "-hwaccel" in calls[0]
    retry = calls[1]
    assert "-hwaccel" not in retry
    assert "hwupload_cuda" in _filter(retry)
    assert "h264_nvenc" in retry


def test_a_real_nvdec_refusal_is_retried_with_the_cpu_decode():
    result, calls = _transcode(H264, "nvenc", failures=[NVDEC_REFUSAL])

    assert result.success is True
    assert len(calls) == 2
    assert "-hwaccel" in calls[0]
    assert "-hwaccel" not in calls[1]
    assert "hwupload_cuda" in _filter(calls[1])


def test_a_missing_cuda_device_on_the_cpu_decode_falls_back_to_software():
    # ProRes has no GPU-decode attempt, so the CPU decode is its only hardware
    # one, and hwupload_cuda is what opens the device.
    result, calls = _transcode(PRORES, "nvenc", failures=[NO_DEVICE])

    assert result.success is True
    assert len(calls) == 2
    assert "hwupload_cuda" in _filter(calls[0])
    assert _is_software(calls[1]), calls[1]


def test_a_missing_cuda_device_on_an_hdr_gpu_decode_skips_to_software():
    # The HDR graph re-uploads with hwupload_cuda, which can fail before
    # -hwaccel gets to create the device.
    result, calls = _transcode({**H264, "color_transfer": "smpte2084"}, "nvenc",
                               failures=[NO_DEVICE])

    assert result.success is True
    assert len(calls) == 2
    assert "-hwaccel" in calls[0]
    assert _is_software(calls[1]), calls[1]


def test_an_unrecognised_failure_on_the_cpu_decode_falls_back_to_software():
    # An 8448x480 source: NVDEC refuses the width, then NVENC refuses the 360p
    # rung as too short. No marker names the second failure.
    result, calls = _transcode(H264, "nvenc", failures=[NVDEC_REFUSAL, NVENC_TOO_SHORT])

    assert result.success is True
    assert len(calls) == 3
    assert "hwupload_cuda" in _filter(calls[1])
    assert _is_software(calls[2]), calls[2]


def test_any_failure_on_a_cpu_decode_only_source_reaches_software():
    result, calls = _transcode(PRORES, "nvenc", failures=[NVENC_TOO_SHORT])

    assert result.success is True
    assert len(calls) == 2
    assert _is_software(calls[1]), calls[1]


def test_the_whole_ladder_ends_on_software():
    result, calls = _transcode(
        H264, "nvenc",
        failures=[DECODE_FAILURE, "OpenEncodeSessionEx failed: unsupported device (2)"])

    assert result.success is True
    assert len(calls) == 3
    assert "-hwaccel" in calls[0]
    assert "hwupload_cuda" in _filter(calls[1])
    assert _is_software(calls[2]), calls[2]


def test_out_of_memory_skips_the_cpu_decode_tier():
    result, calls = _transcode(
        H264, "nvenc", failures=["CUDA_ERROR_OUT_OF_MEMORY: out of memory"])

    assert result.success is True
    assert len(calls) == 2
    assert _is_software(calls[1]), calls[1]


def test_a_content_error_on_the_gpu_decode_still_fails_without_a_retry():
    result, calls = _transcode(
        H264, "nvenc", failures=["Invalid data found when processing input"])

    assert result.success is False
    assert len(calls) == 1


def test_the_fallback_log_names_the_key_and_never_the_presigned_url(capsys):
    _transcode(H264, "nvenc", failures=[f"{PRESIGNED}: {DECODE_FAILURE}"])

    out = capsys.readouterr().out
    assert "'nvenc' (GPU decode) failed at runtime" in out
    assert "retrying with 'nvenc' (CPU decode)" in out
    assert "Function not implemented" in out
    assert KEY in out
    assert "X-Amz-Signature" not in out


def test_the_fallback_log_shows_the_cause_not_the_teardown(capsys):
    _transcode(H264, "nvenc", failures=[
        f"{NVDEC_REFUSAL}\nTerminating thread with return code -22 (Invalid argument)"])

    out = capsys.readouterr().out
    assert NVDEC_REFUSAL in out
    assert "Terminating thread" not in out


def test_the_fallback_log_names_an_unrecognised_cpu_decode_failure(capsys):
    _transcode(PRORES, "nvenc", failures=[NVENC_TOO_SHORT])

    out = capsys.readouterr().out
    assert "unrecognised failure on the CPU-decode attempt" in out
    assert "Frame Dimension less than the minimum" in out
