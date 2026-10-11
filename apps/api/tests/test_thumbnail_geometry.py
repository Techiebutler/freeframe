"""Video thumbnails are de-squeezed and letterboxed onto one 16:9 canvas.

The poster frame used to be written at the source's storage size. JPEG carries
no pixel aspect a browser honours, so an anamorphic master (1440x1080 at 4:3
pixels, a 2x-squeezed scope frame) came out squeezed. Now the frame is scaled
to square pixels and padded to 1280x720, so every card in a grid has the same
shape whether it is shown fitted or filled.
"""
import asyncio
import json
import shutil
import subprocess
from unittest.mock import MagicMock, patch

import pytest

from packages.transcoder.base import TranscodeJob
from packages.transcoder.ffmpeg_transcoder import (
    FFmpegTranscoder,
    _THUMB_GEOMETRY,
    _thumbnail_filter,
)

SDR = {"codec_name": "h264", "pix_fmt": "yuv420p"}
HDR = {"codec_name": "hevc", "pix_fmt": "yuv420p10le", "color_transfer": "smpte2084"}


def _desqueeze_index(vf: str) -> int:
    return vf.index("scale=w='trunc(iw*min(1\\,sar)")


# ── the filter ────────────────────────────────────────────────────────────────

def test_sdr_frames_are_desqueezed_then_letterboxed():
    vf = _thumbnail_filter(is_hdr=False, dv_software=False)

    assert vf.startswith("thumbnail,")
    assert vf.endswith(",format=yuvj420p")
    desqueeze = _desqueeze_index(vf)
    fit = vf.index("force_original_aspect_ratio=decrease")
    pad = vf.index("pad=1280:720:")
    # force_original_aspect_ratio ignores SAR, so the de-squeeze must come first.
    assert desqueeze < fit < pad
    assert vf.count("setsar=1") == 2


@pytest.mark.parametrize("is_hdr, dv_software, colour_step", [
    (True, False, "tonemap=tonemap="),
    (False, True, "libplacebo="),
])
def test_the_geometry_follows_the_tone_map(is_hdr, dv_software, colour_step):
    vf = _thumbnail_filter(is_hdr=is_hdr, dv_software=dv_software)

    assert vf.index(colour_step) < _desqueeze_index(vf)
    assert _THUMB_GEOMETRY in vf


# ── the transcode ─────────────────────────────────────────────────────────────

def _thumbnail_vf(video_stream: dict) -> str:
    """The -vf of the poster-frame command a mocked transcode() runs."""
    calls: list[list[str]] = []

    def run(cmd, **_kwargs):
        calls.append(cmd)
        if "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "V:0":
            stream = {"r_frame_rate": "25/1", "duration": 6.0,
                      "width": 1440, "height": 1080, "sample_aspect_ratio": "4:3",
                      **video_stream}
            return MagicMock(returncode=0, stderr="", stdout=json.dumps({"streams": [stream]}))
        if "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "a":
            return MagicMock(returncode=0, stderr="", stdout=json.dumps({"streams": []}))
        return MagicMock(returncode=0, stderr="", stdout="")

    job = TranscodeJob(media_id="m", version_id="v1", input_s3_key="uploads/a.mov",
                       output_s3_prefix="hls/m/v1", qualities=["720p"])
    s3 = MagicMock()
    s3.generate_presigned_url.return_value = "https://s3.example.com/uploads/a.mov"
    with patch("subprocess.run", side_effect=run), \
         patch("packages.transcoder.ffmpeg_transcoder.get_backend", return_value="cpu"), \
         patch("builtins.open", MagicMock()), \
         patch("pathlib.Path.glob", return_value=[]), \
         patch("pathlib.Path.rglob", return_value=[]), \
         patch("pathlib.Path.mkdir"), \
         patch("shutil.rmtree"):
        asyncio.run(FFmpegTranscoder(s3, "bucket").transcode(job))

    thumbs = [c for c in calls if "-frames:v" in c and "-vf" in c]
    assert len(thumbs) == 1, calls
    return thumbs[0][thumbs[0].index("-vf") + 1]


@pytest.mark.parametrize("stream, is_hdr", [(SDR, False), (HDR, True)])
def test_transcode_uses_the_letterboxed_thumbnail_filter(stream, is_hdr):
    assert _thumbnail_vf(stream) == _thumbnail_filter(is_hdr=is_hdr, dv_software=False)


# ── on real ffmpeg ────────────────────────────────────────────────────────────

def _probe(path) -> tuple[int, int, str]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,sample_aspect_ratio", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    s = json.loads(out)["streams"][0]
    return s["width"], s["height"], s.get("sample_aspect_ratio", "1:1")


def _picture_size(source: str, tmp_path) -> tuple[int, int]:
    """The frame's size inside the letterbox: the filter without its pad."""
    fit_only = _THUMB_GEOMETRY.split(",pad=")[0]
    out = tmp_path / "inner.png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", source,
                    "-vf", fit_only, "-frames:v", "1", str(out)], check=True)
    width, height, _ = _probe(out)
    return width, height


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
@pytest.mark.parametrize("source, picture", [
    ("testsrc=s=960x540:d=1,setsar=2", (1280, 360)),     # 2x squeeze, 3.56:1
    ("testsrc=s=1440x1080:d=1,setsar=4/3", (1280, 720)),  # HDV, 16:9
    ("testsrc=s=720x480:d=1,setsar=8/9", (960, 720)),     # NTSC DV, 4:3
    ("testsrc=s=540x960:d=1", (406, 720)),                # portrait, pillarboxed
])
def test_real_ffmpeg_makes_a_square_pixel_16x9_jpeg(source, picture, tmp_path):
    out = tmp_path / "thumb.jpg"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", source,
                    "-vf", _thumbnail_filter(is_hdr=False, dv_software=False),
                    "-q:v", "2", "-frames:v", "1", str(out)], check=True)

    assert _probe(out) == (1280, 720, "1:1")
    assert _picture_size(source, tmp_path) == picture
