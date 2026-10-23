"""NVENC has a smallest and a largest frame it will encode (#477).

A tall portrait or a very wide video fitted into the 360p box comes out smaller
than `h264_nvenc` opens an encoder for: 720x1920 gives 136x360, and 8000x480
gives 640x38. On the GPU-decode attempt that failure matched no hardware marker,
so the job failed outright, though libx264 encodes those sizes without trouble.

Two things change. An NVENC encoder that will not open is now a hardware
failure that goes straight to the software pipeline, which covers any size limit
on any GPU. And on the NVENC backend a rung whose fit would be under the
encoder's minimum is given a larger box of the source's own shape, so it stays
on the GPU wherever the source is big enough to fill it.
"""
import asyncio
import json
import re
from unittest.mock import MagicMock, patch

import pytest

from packages.transcoder.base import TranscodeJob
from packages.transcoder.ffmpeg_transcoder import (
    QUALITY_MAP,
    FFmpegTranscoder,
    _NVENC_FRAME_LIMITS,
    _hw_failure_reason,
    _is_gpu_decode_failure,
    _is_hw_runtime_failure,
    fitted_size,
    nvenc_rung_target,
    rung_box,
)

PRESIGNED = "https://s3.example.com/uploads/video.mp4?X-Amz-Signature=secret"
KEY = "uploads/video.mp4"

# Real stderr from the worker image's ffmpeg 7.1.5 on an RTX 5070 Ti, trimmed to
# the lines that matter, for a 136x360 and an 8000x360 frame.
NVENC_BELOW_MINIMUM = (
    "[h264_nvenc @ 0x555579ed1a40] InitializeEncoder failed: invalid param (8): "
    "Frame Dimension less than the minimum supported value.\n"
    "[vost#0:0/h264_nvenc @ 0x555579eeb3c0] Error while opening encoder - maybe "
    "incorrect parameters such as bit_rate, rate, width or height.\n"
    "[vf#0:0 @ 0x555579f06500] Error sending frames to consumers: Invalid argument\n"
    "[vf#0:0 @ 0x555579f06500] Terminating thread with return code -22 (Invalid argument)\n"
    "Conversion failed!"
)
HEVC_NVENC_BELOW_MINIMUM = (
    "[hevc_nvenc @ 0x555580ac2a40] InitializeEncoder failed: invalid param (8): "
    "Frame dimensions are less than the minimum supported value.\n"
    "Conversion failed!"
)
NVENC_ABOVE_MAXIMUM = (
    "[h264_nvenc @ 0x55555d003a40] Width 8000 exceeds 4096\n"
    "[h264_nvenc @ 0x55555d003a40] Provided device doesn't support required NVENC features\n"
    "[vost#0:0/h264_nvenc @ 0x55555d006ac0] Error while opening encoder - maybe "
    "incorrect parameters such as bit_rate, rate, width or height.\n"
    "[vf#0:0 @ 0x55555d021c40] Error sending frames to consumers: Function not implemented\n"
    "[vf#0:0 @ 0x55555d021c40] Terminating thread with return code -38 (Function not implemented)\n"
    "Conversion failed!"
)
NVDEC_REFUSAL = "Failed setup for format cuda: hwaccel initialisation returned error."

H264 = {"codec_name": "h264", "pix_fmt": "yuv420p"}
PRORES = {"codec_name": "prores", "pix_fmt": "yuv422p10le"}
ROTATED_90 = {"side_data_list": [{"side_data_type": "Display Matrix", "rotation": -90}]}
DOLBY_VISION_5 = {
    "codec_name": "hevc", "pix_fmt": "yuv420p10le",
    "side_data_list": [{"side_data_type": "DOVI configuration record", "dv_profile": 5}],
}


def _transcode(width, height, backend="nvenc", stream=None, failures=None,
               qualities=("1080p", "720p", "360p")):
    """Run a mocked transcode of a width x height source; return (result, ffmpeg cmds).

    `failures[i]` is the stderr the i-th ffmpeg attempt exits with; attempts past
    the end of the list succeed.
    """
    failures = failures or []
    calls: list[list[str]] = []

    def run(cmd, **_kwargs):
        if "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "V:0":
            probed = {"r_frame_rate": "25/1", "duration": 6.0, **H264,
                      "width": width, "height": height, **(stream or {})}
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


def _boxes(cmd: list[str]) -> dict[str, str]:
    """Each rung's scale box in an ffmpeg command, by rung name."""
    graph = cmd[cmd.index("-filter_complex") + 1]
    return dict((q, box) for box, q in re.findall(r"scale(?:_\w+)?=(\d+:\d+):[^\[]*\[(\w+)\]", graph))


def _is_software(cmd: list[str]) -> bool:
    joined = " ".join(cmd)
    return "-hwaccel" not in joined and "cuda" not in joined and "libx264" in joined


# ── the safety net: an encoder NVENC will not open goes to software ──────────

@pytest.mark.parametrize("stderr", [
    NVENC_BELOW_MINIMUM, HEVC_NVENC_BELOW_MINIMUM, NVENC_ABOVE_MAXIMUM,
], ids=["h264-below-minimum", "hevc-below-minimum", "above-maximum"])
def test_an_nvenc_encoder_that_will_not_open_is_a_hardware_failure(stderr):
    assert _is_hw_runtime_failure(stderr)


@pytest.mark.parametrize("stderr", [
    NVENC_BELOW_MINIMUM, HEVC_NVENC_BELOW_MINIMUM, NVENC_ABOVE_MAXIMUM,
], ids=["h264-below-minimum", "hevc-below-minimum", "above-maximum"])
def test_an_nvenc_encoder_that_will_not_open_is_not_a_decoder_problem(stderr):
    # Decoding on the CPU would hand NVENC the same frame. The size-limit
    # refusal also says "Function not implemented", which on its own does
    # point at the decoder, so the encoder's own words have to win.
    assert not _is_gpu_decode_failure(stderr)


def test_the_fallback_reason_names_the_encoder_not_the_teardown():
    assert _hw_failure_reason(NVENC_BELOW_MINIMUM) == "initializeencoder failed"
    assert _hw_failure_reason(NVENC_ABOVE_MAXIMUM) == \
        "provided device doesn't support required nvenc features"


@pytest.mark.parametrize("stderr", [NVENC_BELOW_MINIMUM, NVENC_ABOVE_MAXIMUM],
                         ids=["below-minimum", "above-maximum"])
def test_a_gpu_decode_attempt_nvenc_refuses_goes_straight_to_software(stderr):
    result, calls = _transcode(1920, 1080, failures=[stderr])

    assert result.success is True, result.error
    assert len(calls) == 2, "the CPU-decode tier would hit the same encoder limit"
    assert "-hwaccel" in calls[0]
    assert _is_software(calls[1]), calls[1]


def test_the_fallback_log_says_the_encoder_refused(capsys):
    _transcode(1920, 1080, failures=[NVENC_BELOW_MINIMUM])

    out = capsys.readouterr().out
    assert "failed at runtime (initializeencoder failed); retrying on the software pipeline" in out
    assert "Frame Dimension less than the minimum supported value" in out


# ── where ffmpeg puts a rung ──────────────────────────────────────────────────

@pytest.mark.parametrize("target, source, expected", [
    # Measured on the worker image's ffmpeg 7.1.5, scale and scale_cuda alike.
    ("640:360", (720, 1920), (136, 360)),
    ("640:360", (904, 2316), (140, 360)),
    ("640:360", (480, 1440), (120, 360)),
    ("640:360", (8000, 480), (640, 38)),
    ("1920:1080", (1080, 1920), (608, 1080)),
    ("1280:720", (1080, 1920), (406, 720)),
    ("640:360", (1080, 1920), (202, 360)),
    ("1920:1080", (1920, 1080), (1920, 1080)),
    ("1920:1080", (1440, 1080), (1440, 1080)),
    ("1280:720", (720, 1920), (270, 720)),
    ("1920:1080", (720, 1920), (406, 1080)),
    ("1280:720", (904, 2316), (282, 720)),
    ("1920:1080", (904, 2316), (422, 1080)),
    ("1280:720", (480, 1440), (240, 720)),
    ("1920:1080", (480, 1440), (360, 1080)),
    ("1280:720", (8000, 480), (1280, 76)),
    ("1920:1080", (8000, 480), (1920, 116)),
])
def test_fitted_size_is_what_ffmpeg_produces(target, source, expected):
    assert fitted_size(target, *source) == expected


# ── keeping the GPU: a larger box for a rung NVENC would refuse ──────────────

@pytest.mark.parametrize("encoder, source, expected", [
    ("h264_nvenc", (720, 1920), "146:390"),
    ("h264_nvenc", (904, 2316), "146:376"),
    ("h264_nvenc", (480, 1440), "146:438"),
    ("h264_nvenc", (8000, 480), "834:50"),
    ("hevc_nvenc", (480, 1440), "130:390"),
])
def test_a_rung_under_the_minimum_gets_a_box_of_the_sources_shape(encoder, source, expected):
    assert nvenc_rung_target("640:360", *source, encoder) == expected
    (min_w, min_h), _ = _NVENC_FRAME_LIMITS[encoder]
    w, h = fitted_size(expected, *source)
    assert w >= min_w and h >= min_h
    assert w % 2 == 0 and h % 2 == 0
    assert abs(w / h - source[0] / source[1]) / (source[0] / source[1]) < 0.02


@pytest.mark.parametrize("encoder, source", [
    ("h264_nvenc", (1920, 1080)),
    ("h264_nvenc", (1080, 1920)),
    ("hevc_nvenc", (720, 1920)),     # 136x360 is inside hevc_nvenc's range
    ("hevc_nvenc", (8000, 480)),     # and so is 640x38
])
def test_a_rung_nvenc_accepts_keeps_its_box(encoder, source):
    assert nvenc_rung_target("640:360", *source, encoder) == "640:360"


@pytest.mark.parametrize("target, source, why", [
    ("120:40", (120, 40), "the source itself is under the minimum"),
    ("640:360", (8000, 90), "the minimum height would upscale the source"),
    ("640:360", (9000, 100), "834:50's equivalent would pass the maximum width"),
])
def test_a_rung_that_cannot_be_enlarged_is_left_to_the_software_fallback(target, source, why):
    assert nvenc_rung_target(target, *source, "h264_nvenc") == target, why


def test_an_encoder_with_no_known_limits_is_left_alone():
    assert nvenc_rung_target("640:360", 720, 1920, "h264_vaapi") == "640:360"
    assert nvenc_rung_target("640:360", 0, 0, "h264_nvenc") == "640:360"


@pytest.mark.parametrize("encoder", sorted(_NVENC_FRAME_LIMITS))
def test_every_enlarged_rung_fits_the_encoder_and_the_source(encoder):
    (min_w, min_h), (max_w, max_h) = _NVENC_FRAME_LIMITS[encoder]
    checked = portrait = 0
    for width in range(32, 9000, 37):
        for height in range(32, 9000, 41):
            for name, (landscape, _crf) in QUALITY_MAP.items():
                # The transcoder hands nvenc_rung_target the box rung_box()
                # turned to the frame (#452), portrait for a portrait source.
                for target in {landscape, rung_box(landscape, width, height)}:
                    new = nvenc_rung_target(target, width, height, encoder)
                    before = fitted_size(target, width, height)
                    if new == target:
                        continue
                    checked += 1
                    if target != landscape:
                        portrait += 1
                    assert before[0] < min_w or before[1] < min_h, (width, height, name, target)
                    w, h = fitted_size(new, width, height)
                    assert min_w <= w <= min(max_w, width), (width, height, name, target, new)
                    assert min_h <= h <= min(max_h, height), (width, height, name, target, new)
                    # Never smaller than the rung it replaces, in either direction.
                    assert w >= before[0] and h >= before[1], (width, height, name, target, new)
    assert checked > 1000
    assert portrait > 100


# ── the ladder each attempt builds ────────────────────────────────────────────

def test_a_portrait_source_fits_nvenc_with_its_own_rungs():
    # A portrait rung is sized by its short side (#452), so 720x1920's 360p is
    # 240x640 now rather than 136x360, and needs no larger box.
    result, calls = _transcode(720, 1920)

    assert result.success is True
    assert len(calls) == 1
    assert _boxes(calls[0]) == {"720p": "720:1280", "360p": "360:640"}


def test_a_very_tall_portrait_keeps_the_gpu_with_a_larger_360p_rung():
    # 400x1920 in 360:640 is 134x640, still under h264_nvenc's 146.
    result, calls = _transcode(400, 1920)

    assert result.success is True
    assert len(calls) == 1
    assert "-hwaccel" in calls[0] and "h264_nvenc" in calls[0]
    assert _boxes(calls[0]) == {"360p": "146:702"}


def test_a_very_wide_source_keeps_the_gpu_with_a_taller_360p_rung():
    _, calls = _transcode(8000, 480)

    assert _boxes(calls[0]) == {"360p": "834:50"}


def test_a_source_nvenc_takes_as_it_is_keeps_every_box():
    _, calls = _transcode(1920, 1080)
    assert _boxes(calls[0]) == {q: QUALITY_MAP[q][0] for q in ("1080p", "720p", "360p")}
    _, calls = _transcode(1080, 1920)
    assert _boxes(calls[0]) == {"1080p": "1080:1920", "720p": "720:1280", "360p": "360:640"}


def test_hevc_output_uses_hevc_nvencs_own_minimum(monkeypatch):
    monkeypatch.setenv("TRANSCODER_OUTPUT", "h265_10")
    _, narrow = _transcode(360, 1920)
    _, portrait = _transcode(400, 1920)

    assert "hevc_nvenc" in narrow[0]
    assert _boxes(narrow[0])["360p"] == "130:694"
    # 134x640, which h264_nvenc refuses and hevc_nvenc takes.
    assert _boxes(portrait[0])["360p"] == "360:640"


@pytest.mark.parametrize("backend", ["cpu", "vaapi", "qsv"])
def test_other_backends_keep_the_ladder_they_had(backend):
    _, calls = _transcode(400, 1920, backend=backend)

    assert _boxes(calls[0])["360p"] == "360:640"


def test_dolby_vision_5_on_nvenc_keeps_the_ladder_it_had():
    # Profile 5 is encoded in software whatever the backend, so NVENC's limits
    # do not apply to it.
    _, calls = _transcode(400, 1920, stream=DOLBY_VISION_5)

    assert len(calls) == 1 and "h264_nvenc" not in calls[0]
    assert _boxes(calls[0])["360p"] == "360:640"


def test_a_rotated_dolby_vision_5_source_gets_upright_rungs_on_nvenc():
    # Profile 5 is decoded and scaled in software whatever the backend, so
    # ffmpeg autorotates its frames before the graph and the scaler is handed
    # 1080x1920: the boxes are turned, as for any frame in system memory.
    stream = {**DOLBY_VISION_5, "side_data_list": [
        *DOLBY_VISION_5["side_data_list"], *ROTATED_90["side_data_list"],
    ]}
    _, calls = _transcode(1920, 1080, stream=stream)

    assert len(calls) == 1 and "h264_nvenc" not in calls[0]
    assert _boxes(calls[0]) == {"1080p": "1080:1920", "720p": "720:1280", "360p": "360:640"}


def test_the_software_fallback_keeps_the_ladder_it_had():
    # Whatever made NVENC fail, libx264 gets the ordinary boxes.
    result, calls = _transcode(400, 1920, failures=[NVENC_BELOW_MINIMUM])

    assert result.success is True
    assert _is_software(calls[1])
    assert _boxes(calls[1])["360p"] == "360:640"


def test_a_rotated_source_is_sized_as_the_scaler_sees_it():
    # Stored 1920x400 with a 90-degree display matrix. ffmpeg autorotates a
    # frame in system memory before the graph and leaves a CUDA one alone, so a
    # rotated source is never decoded into CUDA frames: both attempts scale
    # 400x1920, whose 360p fit (134x640) is under h264_nvenc's minimum. Sized
    # as stored, it would be 640x134 and keep its box.
    result, calls = _transcode(1920, 400, stream=ROTATED_90, failures=[NVDEC_REFUSAL])

    assert result.success is True
    gpu_decode, cpu_decode = calls
    assert "-hwaccel" in gpu_decode and "-hwaccel_output_format" not in gpu_decode
    assert _boxes(gpu_decode) == {"360p": "146:702"}
    assert "hwupload_cuda" in cpu_decode[cpu_decode.index("-filter_complex") + 1]
    assert _boxes(cpu_decode) == {"360p": "146:702"}


def test_a_rotated_source_the_gpu_cannot_decode_is_sized_upright():
    # ProRes starts on the CPU decode, so it is autorotated from the outset.
    _, calls = _transcode(1920, 400, stream={**PRORES, **ROTATED_90})

    assert "-hwaccel" not in calls[0]
    assert _boxes(calls[0])["360p"] == "146:702"
