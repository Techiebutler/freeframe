"""Server-side drawn frame (spec 2026-11-18 T3): clustering, stroke pixels on a synthetic frame, source choice by version."""
import io
import shutil
import subprocess
import uuid
from types import SimpleNamespace

import pytest

PIL = pytest.importorskip("PIL")
from PIL import Image, ImageChops  # noqa: E402

from apps.api.services import drawn_frame as df  # noqa: E402

STROKE = {"k": "stroke", "t": 7.67, "offset_ms": 6900, "times": [0, 16, 33], "points": [[0.1, 0.5], [0.5, 0.5], [0.9, 0.5]]}


def test_marks_within_the_frame_tolerance_share_one_frame_and_t_is_the_marks_own_time():
    dd = {"format": "ink.v1", "marks": [STROKE, {**STROKE, "t": 7.8}, {**STROKE, "t": 9.5}, {"k": "stroke", "t": 1.0, "points": []}, {"k": "dot", "points": [[0.2, 0.2]]}]}
    frames = df.cluster_marks(dd)
    assert [(f.t, f.mark_ids) for f in frames] == [(7.67, ["m0", "m1"]), (9.5, ["m2"])]  # empty and t-less marks skipped; ids = index in marks


def test_burn_in_draws_the_stroke_and_leaves_the_rest_of_the_frame_alone():
    base = Image.new("RGB", (100, 100), (40, 40, 40))
    out = df.burn_in(base, [STROKE])
    assert out.size == (100, 100) and out.mode == "RGB"
    r, g, b = out.getpixel((50, 50))
    assert r > 200 and g < 90 and b < 90   # red core on the stroke
    assert out.getpixel((50, 5)) == (40, 40, 40) and out.getpixel((2, 95)) == (40, 40, 40)
    assert base.getpixel((50, 50)) == (40, 40, 40)   # the source image is untouched


def test_a_dot_is_a_ring_not_a_filled_disc():
    out = df.burn_in(Image.new("RGB", (200, 200), (0, 0, 0)), [{"k": "dot", "points": [[0.5, 0.5]]}])
    ring = max(range(0, 100), key=lambda x: out.getpixel((100 + x, 100))[0])
    assert 5 <= ring <= 20 and out.getpixel((100, 100)) == (0, 0, 0)


def test_png_is_capped_at_1280_on_the_long_side():
    png, w, h = df.to_png(Image.new("RGB", (2160, 3840)))
    assert (w, h) == (720, 1280) and Image.open(io.BytesIO(png)).format == "PNG"


def test_source_is_the_media_of_this_exact_version_raw_first_then_the_review_proxy():
    v, other = uuid.uuid4(), uuid.uuid4()
    media = SimpleNamespace(version_id=v, s3_key_raw="raw/v.mp4", s3_key_processed="processed/p/a/v/")
    assert df.source_candidates(media, version_id=v) == [
        ("raw", "raw/v.mp4"), ("proxy", "processed/p/a/v/review_540.mp4"), ("proxy", "processed/p/a/v/ai_proxy.mp4")]
    assert df.source_candidates(media, version_id=other) == []   # never another version's file
    assert df.source_candidates(None, version_id=v) == []


def test_render_asks_for_the_mark_time_of_each_cluster_and_falls_back_to_the_proxy():
    asked = []

    def extract(key, t):
        asked.append((key, t))
        if key == "raw":
            raise RuntimeError("raw not retained")
        return Image.new("RGB", (64, 114), (10, 10, 10))

    out = df.render_frames({"marks": [STROKE, {**STROKE, "t": 9.5}]}, version_id="v1", sources=[("raw", "raw"), ("proxy", "proxy")], extract=extract)
    assert asked == [("raw", 7.67), ("proxy", 7.67), ("raw", 9.5), ("proxy", 9.5)]
    assert [(o["t"], o["mark_ids"], o["source"], o["version_id"]) for o in out] == [(7.67, ["m0"], "proxy", "v1"), (9.5, ["m1"], "proxy", "v1")]
    assert Image.open(io.BytesIO(out[0]["png"])).size == (64, 114)


def test_render_raises_when_no_source_gives_the_frame():
    def boom(key, t):
        raise RuntimeError("nope")
    with pytest.raises(RuntimeError):
        df.render_frames({"marks": [STROKE]}, version_id="v1", sources=[("raw", "k")], extract=boom)


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")
def test_real_ffmpeg_extracts_the_frame_at_the_mark_time_and_the_stroke_differs_from_a_plain_extract(tmp_path):
    src = str(tmp_path / "v.mp4")
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=25:duration=3",
                    "-pix_fmt", "yuv420p", src], check=True)
    plain = df.extract_frame(src, 1.5)
    late = df.extract_frame(src, 2.5)
    assert plain.size == (180, 320) and ImageChops.difference(plain, late).getbbox()   # the seek really moved
    drawn = df.burn_in(plain, [{"k": "stroke", "t": 1.5, "points": [[0.1, 0.5], [0.9, 0.5]]}])
    box = ImageChops.difference(plain, drawn).getbbox()
    assert box and box[1] > 140 and box[3] < 180   # pixels changed, only around the stroke row (y = 160)
