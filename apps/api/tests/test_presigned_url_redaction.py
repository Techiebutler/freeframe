"""A failed transcode must not hand out the presigned URL it was reading.

The transcoder gives ffmpeg and ffprobe a presigned GET for the raw upload,
valid for two hours. Both print that URL back in their stderr, and a timeout
carries it too, inside the argv that `subprocess.TimeoutExpired` quotes. Every
one of those used to be copied into the exception message, then into
`TranscodeResult.error`, the `transcode_failed` SSE event that every member of
the project receives, the Celery result backend and the worker log.

The stderr fixtures below are real ffmpeg 7.1.1 output, captured against a
local server with a boto3 SigV4 URL signed by a fake key, with the URL replaced
by `{url}`. ffmpeg prints the URL byte for byte (not percent-decoded, not
truncated), so substituting it back reproduces what the code really sees.

What must not survive is the query string: X-Amz-Credential carries the access
key id and X-Amz-Signature is what makes the URL a bearer token. The path is
kept on purpose, since it is the object key an operator needs to find the file.
"""
import asyncio
import json
import logging
import os
import subprocess
import time
import traceback
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.asset import AssetType, ProcessingStatus
from apps.api.tasks import transcode_tasks
from packages.transcoder.base import TranscodeJob
from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder
from packages.transcoder.redact import redact_presigned_urls

_SIGNATURE = "ce9888ed69a7543c80336b32a476884e713e80f8c959de153644b3600c4ae91a"
_KEY_ID = "AKIAFAKEKEYID000TEST"
_KEY = "raw/p/a/v/clip (1) ü.mp4"
_PATH = "/bucket/raw/p/a/v/clip%20%281%29%20%C3%BC.mp4"
_URL = (
    f"http://127.0.0.1:18911{_PATH}?X-Amz-Algorithm=AWS4-HMAC-SHA256"
    f"&X-Amz-Credential={_KEY_ID}%2F20261011%2Fus-east-1%2Fs3%2Faws4_request"
    "&X-Amz-Date=20261011T145517Z&X-Amz-Expires=7200&X-Amz-SignedHeaders=host"
    f"&X-Amz-Signature={_SIGNATURE}"
)

# ffprobe -v error, source answers 403.
_FFPROBE_403 = "{url}: Server returned 403 Forbidden (access denied)\n"
# ffmpeg -hide_banner, source answers 403.
_FFMPEG_OPEN_FAILED = (
    "[http @ 0x751501c000] HTTP error 403 Forbidden\n"
    "[in#0 @ 0x7514c58000] Error opening input: Server returned 403 Forbidden (access denied)\n"
    "Error opening input file {url}.\n"
    "Error opening input files: Server returned 403 Forbidden (access denied)\n"
)
# ffmpeg on a readable source whose output fails: the URL is quoted.
_FFMPEG_OUTPUT_FAILED = (
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '{url}':\n"
    "  Duration: 00:00:01.00, start: 0.000000, bitrate: 36 kb/s\n"
    "[vost#0:0 @ 0x76e2cd8300] Unknown encoder 'nonexistent_codec'\n"
    "Error opening output file /tmp/x.mp4.\n"
    "Error opening output files: Encoder not found\n"
)
# ffprobe -v trace: the request line carries path and query with no host, so
# replacing the full URL string would miss it.
_TRACE_REQUEST = (
    "[http @ 0x7837040000] request: GET " + _URL.split("18911", 1)[1] + " HTTP/1.1\n"
)


def _leaks(text: str) -> list[str]:
    return [s for s in (_SIGNATURE, _KEY_ID, "X-Amz-Credential", "X-Amz-Signature")
            if s in text]


# ── the scrubber itself ───────────────────────────────────────────────────────

@pytest.mark.parametrize("stderr", [
    _FFPROBE_403, _FFMPEG_OPEN_FAILED, _FFMPEG_OUTPUT_FAILED, _TRACE_REQUEST,
], ids=["ffprobe-403", "ffmpeg-open", "ffmpeg-input-banner", "trace-request-line"])
def test_every_form_ffmpeg_prints_loses_the_signed_query(stderr):
    text = stderr.format(url=_URL)
    assert _SIGNATURE in text  # the fixture really carries it

    scrubbed = redact_presigned_urls(text)

    assert _leaks(scrubbed) == []
    assert _PATH in scrubbed, "the object path is what an operator needs to find the file"


def test_the_message_around_the_url_is_kept():
    scrubbed = redact_presigned_urls(_FFPROBE_403.format(url=_URL))
    assert scrubbed.endswith(": Server returned 403 Forbidden (access denied)\n")
    scrubbed = redact_presigned_urls(_FFMPEG_OPEN_FAILED.format(url=_URL))
    assert f"Error opening input file http://127.0.0.1:18911{_PATH}?<redacted>.\n" in scrubbed
    scrubbed = redact_presigned_urls(_FFMPEG_OUTPUT_FAILED.format(url=_URL))
    assert f"from 'http://127.0.0.1:18911{_PATH}?<redacted>':\n" in scrubbed


def test_a_sigv2_url_is_scrubbed_too():
    url = ("https://s3.example.com/bucket/raw/x.mov?AWSAccessKeyId=" + _KEY_ID
           + "&Expires=1760000000&Signature=Zm9vYmFy%2Bc2lnbmF0dXJl%3D")
    scrubbed = redact_presigned_urls(f"{url}: Server returned 403 Forbidden")
    assert _KEY_ID not in scrubbed and "Zm9vYmFy" not in scrubbed


def test_a_query_with_a_dot_in_it_is_scrubbed_to_the_end():
    """Stopping at the first `.` (as if it were the sentence's full stop) would
    leave everything after it, signature included."""
    url = ("https://s3.example.com/b/k.mp4?response-content-disposition=attachment"
           "%3B%20filename%3D%22clip.mp4%22&X-Amz-Signature=" + _SIGNATURE)
    assert _SIGNATURE not in redact_presigned_urls(f"Error opening input file {url}.")


def test_every_signed_url_in_the_text_is_scrubbed():
    text = _FFPROBE_403.format(url=_URL) + _FFMPEG_OPEN_FAILED.format(url=_URL)
    assert text.count(_SIGNATURE) == 2
    assert _leaks(redact_presigned_urls(text)) == []


def test_a_long_token_full_of_question_marks_is_scrubbed_in_linear_time():
    """ffmpeg echoes a source's metadata tags, which the uploader controls, and
    the scrub runs on that stderr. A lookahead per `?` made this quadratic:
    about 6 s for 20,000 of them."""
    text = "    title           : " + "?" * 200_000 + "\n" + _FFPROBE_403.format(url=_URL)
    started = time.monotonic()
    scrubbed = redact_presigned_urls(text)
    assert time.monotonic() - started < 1.0
    assert _leaks(scrubbed) == []
    assert "?" * 200_000 in scrubbed


def test_text_without_a_signed_url_is_left_alone():
    text = ("Conversion failed! CUDA_ERROR_OUT_OF_MEMORY see https://trac.ffmpeg.org/?q=1 "
            "and /tmp/hls/360p/playlist.m3u8")
    assert redact_presigned_urls(text) == text


# ── the runners: where stderr and argv become exception text ─────────────────

def _fake_tool(tmp_path, name: str, stderr: str, *, sleep: int = 0, code: int = 1):
    """An executable that behaves like ffprobe/ffmpeg on a bad source: it
    prints the captured stderr with the URL it was actually given."""
    fixture = tmp_path / f"{name}.stderr"
    fixture.write_text(stderr.replace("{url}", "@URL@"))
    tool = tmp_path / name
    tool.write_text(
        "#!/bin/sh\n"
        'for a; do last="$a"; done\n'
        f"{'sleep ' + str(sleep) if sleep else ':'}\n"
        # Plain parameter expansion, not sed: `&` in a sed replacement is the
        # matched text, and a presigned query is full of `&`.
        "while IFS= read -r line; do\n"
        '  case "$line" in\n'
        '    *@URL@*) printf \'%s%s%s\\n\' "${line%%@URL@*}" "$last" "${line#*@URL@}" ;;\n'
        "    *) printf '%s\\n' \"$line\" ;;\n"
        "  esac\n"
        f'done < "{fixture}" >&2\n'
        f"exit {code}\n"
    )
    tool.chmod(0o755)
    return str(tool)


def _transcoder() -> FFmpegTranscoder:
    return FFmpegTranscoder.__new__(FFmpegTranscoder)


def test_run_does_not_put_the_url_from_stderr_in_its_error(tmp_path):
    tool = _fake_tool(tmp_path, "ffprobe", _FFPROBE_403)
    with pytest.raises(RuntimeError) as exc:
        FFmpegTranscoder._run([tool, "-v", "error", _URL], timeout=30, label="ffprobe")
    assert "Server returned 403 Forbidden" in str(exc.value), "the cause must survive"
    assert _leaks(str(exc.value)) == []


def test_run_does_not_put_the_url_from_argv_in_a_timeout(tmp_path):
    tool = _fake_tool(tmp_path, "ffprobe", "", sleep=30)
    with pytest.raises(subprocess.TimeoutExpired) as exc:
        FFmpegTranscoder._run([tool, "-v", "error", _URL], timeout=1, label="ffprobe")
    # The whole formatted traceback, because that is what Celery stores and
    # logs -- a chained original exception would carry the URL there.
    rendered = "".join(traceback.format_exception(exc.value))
    assert "timed out after 1 seconds" in rendered
    assert _leaks(rendered) == []


def test_run_with_progress_does_not_put_the_url_from_stderr_in_its_error(tmp_path):
    tool = _fake_tool(tmp_path, "ffmpeg", _FFMPEG_OPEN_FAILED, code=8)
    with pytest.raises(RuntimeError) as exc:
        _transcoder()._run_with_progress(
            [tool, "-y", "-i", _URL], timeout=30, duration_seconds=10.0,
            on_percent=lambda p: None,
        )
    assert "Error opening input files" in str(exc.value)
    assert _leaks(str(exc.value)) == []


def test_run_with_progress_does_not_put_the_url_from_argv_in_a_timeout(tmp_path):
    tool = _fake_tool(tmp_path, "ffmpeg", "", sleep=30)
    with pytest.raises(subprocess.TimeoutExpired) as exc:
        # The URL sits mid-argv, as in the real encode command.
        _transcoder()._run_with_progress(
            [tool, "-y", "-i", _URL, "-f", "null", "-"], timeout=1, duration_seconds=10.0,
            on_percent=lambda p: None,
        )
    rendered = "".join(traceback.format_exception(exc.value))
    assert _leaks(rendered) == []


# ── the keyframe probe's refusal text, which is printed to the worker log ─────

def _packets(n: int) -> str:
    return json.dumps({"packets": [{"pts_time": f"{i}.0", "flags": "K__"} for i in range(n)]})


def test_a_keyframe_probe_timeout_is_refused_without_the_url():
    def run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))

    with patch("subprocess.run", side_effect=run):
        refusal = _transcoder()._copy_window_refusal(_URL, 0.0, 30.0, 60.0)
    assert refusal and "keyframe probe failed" in refusal
    assert _leaks(refusal) == []


def test_a_trace_probe_timeout_is_refused_without_the_url():
    """The second probe calls subprocess.run itself rather than _run."""
    def run(cmd, **kwargs):
        if cmd[0] == "ffprobe":
            return subprocess.CompletedProcess(cmd, 0, stdout=_packets(30), stderr="")
        raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))

    with patch("subprocess.run", side_effect=run):
        refusal = _transcoder()._copy_window_refusal(_URL, 0.0, 30.0, 60.0)
    assert refusal and "keyframe probe failed" in refusal
    assert _leaks(refusal) == []


# ── transcode(): the returned error ───────────────────────────────────────────

def _job() -> TranscodeJob:
    return TranscodeJob(media_id="m", version_id=str(uuid.uuid4()), input_s3_key=_KEY,
                        output_s3_prefix="processed/x", qualities=["360p"])


def _signing_transcoder() -> FFmpegTranscoder:
    s3 = MagicMock()
    s3.generate_presigned_url.return_value = _URL
    return FFmpegTranscoder(s3, "bucket")


def test_a_failed_probe_returns_an_error_without_the_url(tmp_path, monkeypatch):
    """Through the real transcode(): ffprobe on PATH is the fake, nothing else is."""
    _fake_tool(tmp_path, "ffprobe", _FFPROBE_403)
    monkeypatch.setenv("PATH", f"{tmp_path}:{os.environ['PATH']}")

    result = asyncio.run(_signing_transcoder().transcode(_job()))

    assert result.success is False
    assert "Server returned 403 Forbidden" in result.error
    assert _leaks(result.error) == []


def test_transcode_scrubs_any_error_on_the_way_out():
    """The backstop at the boundary, for an exception raised anywhere else."""
    transcoder = _signing_transcoder()
    with patch.object(FFmpegTranscoder, "_run",
                      side_effect=RuntimeError(f"something unforeseen: {_URL}")):
        result = asyncio.run(transcoder.transcode(_job()))
    assert result.success is False
    assert "something unforeseen" in result.error
    assert _leaks(result.error) == []


# ── the task: SSE payload, the exception Celery stores, the backfill log ──────

def _drive_failing_process_asset(process_video):
    asset = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4(),
                            asset_type=AssetType.video)
    version = SimpleNamespace(id=uuid.uuid4(), processing_status=ProcessingStatus.uploading)
    media_file = SimpleNamespace(version_id=version.id, s3_key_raw=_KEY)
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.first.side_effect = [version, asset, media_file]
    s3 = MagicMock()
    s3.generate_presigned_url.return_value = _URL

    published = []
    task = transcode_tasks.process_asset
    task = getattr(task, "_get_current_object", lambda: task)()
    task.push_request(retries=3, called_directly=False)  # the final attempt
    try:
        with patch.object(transcode_tasks, "SessionLocal", return_value=db), \
             patch.object(transcode_tasks, "get_s3_client", return_value=s3), \
             patch.object(transcode_tasks, "_process_video", side_effect=process_video), \
             patch.object(transcode_tasks, "_publish_event",
                          side_effect=lambda p, t, pl: published.append((t, pl))):
            with pytest.raises(Exception) as raised:
                task.run(str(asset.id), str(version.id))
    finally:
        task.pop_request()
    return published, raised.value


def test_the_final_failure_event_and_exception_carry_no_url(tmp_path, monkeypatch):
    """End to end through the real _process_video and FFmpegTranscoder."""
    _fake_tool(tmp_path, "ffprobe", _FFPROBE_403)
    monkeypatch.setenv("PATH", f"{tmp_path}:{os.environ['PATH']}")

    published, exc = _drive_failing_process_asset(transcode_tasks._process_video)

    assert [t for t, _ in published] == ["transcode_failed"]
    error = published[0][1]["error"]
    assert "Server returned 403 Forbidden" in error
    assert _leaks(error) == []
    # What Celery writes to the result backend and the worker log.
    assert _leaks("".join(traceback.format_exception(exc))) == []


def test_the_failure_event_is_scrubbed_whatever_raised():
    """Belt and braces: the SSE payload goes to every project member, so it is
    scrubbed even when the exception did not come through the transcoder."""
    published, _ = _drive_failing_process_asset(
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError(f"boom {_URL}")))
    error = published[0][1]["error"]
    assert error.startswith("boom http://127.0.0.1:18911")
    assert _leaks(error) == []


def test_backfill_does_not_log_the_url_of_a_probe_that_timed_out(caplog):
    from apps.api.tasks.transcode_tasks import backfill_media_metadata

    media_file = MagicMock(duration_seconds=None, s3_key_raw=_KEY)
    db = MagicMock()
    db.query.return_value = db
    db.join.return_value = db
    db.filter.return_value = db
    db.all.return_value = [(media_file, AssetType.video)]

    def run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))

    with patch("apps.api.tasks.transcode_tasks.SessionLocal", return_value=db), \
         patch("apps.api.tasks.transcode_tasks.get_s3_client") as s3, \
         patch("subprocess.run", side_effect=run), \
         caplog.at_level(logging.WARNING, logger="celery.transcode"):
        s3.return_value.generate_presigned_url.return_value = _URL
        result = backfill_media_metadata.apply().get()

    assert result == {"updated": 0, "skipped": 1}
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert "timed out after 300 seconds" in logged
    assert _leaks(logged) == []
