"""The watermark re-encode runs on the transcoding queue, so it keeps its budget.

`apply_watermark` is routed to the same queue as `process_asset`, and a
`drawtext` filter forces a full re-encode of the video. Before #396 it built its
own ffmpeg command with no thread options, so `TRANSCODER_CPU_LIMIT` capped every
transcode on a worker and left this one free to take the machine. These tests
pin the budget on its command, the explicit codec and pixel format that keep a
10-bit source playable in a browser, and that a timed-out encode is not retried.
"""
import json
import os
import shutil
import subprocess
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.asset import Asset, AssetVersion, MediaFile
from apps.api.tasks.watermark_tasks import apply_watermark


@pytest.fixture(autouse=True)
def _a_machine_of_a_known_size(monkeypatch):
    """Pin the core count: a budget at or above it resolves to unbounded."""
    monkeypatch.setattr(
        "packages.transcoder.ffmpeg_transcoder.available_cpus", lambda: 16
    )


def _mock_db(filename="clip.mp4"):
    asset = SimpleNamespace(id="00000000-0000-0000-0000-000000000001",
                            project_id="00000000-0000-0000-0000-000000000002")
    version = SimpleNamespace(id="00000000-0000-0000-0000-000000000003")
    source = SimpleNamespace(original_filename=filename, s3_key_raw="raw/clip.mp4")
    rows = {Asset: asset, AssetVersion: version, MediaFile: source}

    def query(model):
        q = MagicMock()
        q.filter.return_value = q
        q.order_by.return_value = q
        q.first.return_value = rows[model]
        return q

    db = MagicMock()
    db.query.side_effect = query
    return db


def _run_task(run, download=None):
    """Run the task with the DB, S3 and SSE mocked; return what was uploaded."""
    uploaded = {}
    s3 = MagicMock()
    if download:
        s3.download_file.side_effect = download

    # **kwargs: put_object grows keyword options (such as media=) that these tests do not care about.
    def put_object(key, data, content_type, **kwargs):
        uploaded["key"], uploaded["data"] = key, data

    with patch("apps.api.tasks.watermark_tasks.SessionLocal", return_value=_mock_db()), \
         patch("apps.api.services.s3_service.get_s3_client", return_value=s3), \
         patch("apps.api.services.s3_service.put_object", side_effect=put_object), \
         patch("apps.api.tasks.watermark_tasks._publish_event"), \
         patch("apps.api.tasks.watermark_tasks.subprocess.run", side_effect=run), \
         patch.object(apply_watermark, "retry", side_effect=RuntimeError("retried")) as retry:
        apply_watermark.run("00000000-0000-0000-0000-000000000001",
                            "CONFIDENTIAL", "center", 0.5, None)
    return uploaded, retry


def _ffmpeg_cmd():
    captured = []

    def run(cmd, **_kwargs):
        captured.append(cmd)
        with open(cmd[-1], "wb") as f:
            f.write(b"mp4")
        return MagicMock(returncode=0)

    _run_task(run)
    assert len(captured) == 1
    return captured[0]


def _value_after(cmd, flag):
    assert flag in cmd, f"{flag} missing from {cmd}"
    return cmd[cmd.index(flag) + 1]


def test_budget_reaches_the_encoder_and_the_filter_graph(monkeypatch):
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "2")
    cmd = _ffmpeg_cmd()

    # Per output stream: a global -threads before -i reaches only the decoder.
    assert _value_after(cmd, "-threads:v:0") == "2"
    assert "-threads" not in cmd
    # A -vf graph takes -filter_threads. ffmpeg accepts -filter_complex_threads
    # here without complaint and leaves the graph unbounded.
    assert _value_after(cmd, "-filter_threads") == "1"
    assert "-filter_complex_threads" not in cmd


def test_budget_as_a_share_of_the_machine(monkeypatch):
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "50%")
    cmd = _ffmpeg_cmd()

    assert _value_after(cmd, "-threads:v:0") == "8"
    assert _value_after(cmd, "-filter_threads") == "4"


def test_no_budget_leaves_thread_selection_to_ffmpeg(monkeypatch):
    monkeypatch.delenv("TRANSCODER_CPU_LIMIT", raising=False)
    cmd = _ffmpeg_cmd()

    assert not [arg for arg in cmd if arg.startswith("-threads") or arg.endswith("_threads")]


def test_codec_and_pixel_format_are_chosen(monkeypatch):
    monkeypatch.delenv("TRANSCODER_CPU_LIMIT", raising=False)
    cmd = _ffmpeg_cmd()

    assert _value_after(cmd, "-c:v") == "libx264"
    assert _value_after(cmd, "-pix_fmt") == "yuv420p"
    assert _value_after(cmd, "-c:a") == "copy"
    # 4:2:0 needs even dimensions, so the graph pads an odd-sized source.
    assert _value_after(cmd, "-vf").endswith(",pad=ceil(iw/2)*2:ceil(ih/2)*2")


def test_a_timed_out_encode_is_not_retried():
    def run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))

    with pytest.raises(subprocess.TimeoutExpired):
        _run_task(run)


def test_other_failures_still_retry():
    def run(cmd, **_kwargs):
        raise subprocess.CalledProcessError(1, cmd)

    with pytest.raises(RuntimeError, match="retried"):
        _run_task(run)


def _drawtext_works() -> bool:
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        return False
    probe = subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=size=32x32:duration=0.1",
         "-vf", "drawtext=text='x'", "-f", "null", "-"],
        capture_output=True,
    )
    return probe.returncode == 0


@pytest.mark.skipif(not _drawtext_works(), reason="needs ffmpeg with a working drawtext")
def test_odd_sized_10bit_source_comes_out_browser_playable(monkeypatch, tmp_path):
    """Real ffmpeg: a 4:4:4 10-bit source with odd dimensions encodes to 8-bit 4:2:0.

    Without `-pix_fmt` libx264 keeps the source's format, and High 4:4:4 or High 10
    plays in no mainstream browser. With it but without the pad, libx264 refuses
    the odd width outright.
    """
    monkeypatch.setenv("TRANSCODER_CPU_LIMIT", "2")
    source = tmp_path / "source.mp4"
    # testsrc2 rounds its size down to even, so the odd size comes from a scale.
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
         "-i", "testsrc2=size=320x240:rate=25:duration=1", "-vf", "scale=321:241",
         "-c:v", "libx264", "-pix_fmt", "yuv444p10le", str(source)],
        check=True,
    )

    def download(_bucket, _key, path):
        shutil.copyfile(source, path)

    uploaded, retry = _run_task(subprocess.run, download=download)
    retry.assert_not_called()

    out = tmp_path / "out.mp4"
    out.write_bytes(uploaded["data"])
    stream = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=codec_name,pix_fmt,width,height", "-of", "json", str(out)],
        check=True, capture_output=True, text=True,
    ).stdout)["streams"][0]
    assert stream["codec_name"] == "h264"
    assert stream["pix_fmt"] == "yuv420p"
    assert (stream["width"], stream["height"]) == (322, 242)
    assert uploaded["key"] == "watermarked/00000000-0000-0000-0000-000000000001/output.mp4"
    assert os.path.getsize(out) > 0
