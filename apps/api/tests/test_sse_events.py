"""Tests for the SSE event bus: the sync emit path and ffmpeg progress parsing.

Covers the gap behind #294, where the frontend subscribed to six events but the
backend only ever published two. These tests pin the parts that can be checked
without a broker or a real ffmpeg: that publish_sync encodes and routes
correctly, that it never propagates a broker failure into the caller, and that
the progress parser maps ffmpeg's output to sane percentages.
"""
import json
import subprocess
import time
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from apps.api.services import event_service
from packages.transcoder.ffmpeg_transcoder import (
    FFmpegTranscoder,
    _is_hw_runtime_failure,
    parse_progress_percent,
)


def _transcoder() -> FFmpegTranscoder:
    """_run_with_progress touches no instance state, so skip __init__ (which
    would build an S3 client this test has no use for)."""
    return FFmpegTranscoder.__new__(FFmpegTranscoder)


# ── publish_sync ──────────────────────────────────────────────────────────────

def test_publish_sync_sends_typed_envelope_on_the_project_channel():
    """The stream reader parses {"type", "payload"}, so the writer must match it."""
    fake = MagicMock()
    with patch.object(event_service, "_get_sync_redis", return_value=fake):
        assert event_service.publish_sync("proj-1", "new_comment", {"comment_id": "c-1"}) is True

    channel, message = fake.publish.call_args[0]
    assert channel == "project:proj-1"
    assert json.loads(message) == {
        "type": "new_comment",
        "payload": {"comment_id": "c-1"},
    }


def test_publish_sync_accepts_a_uuid_project_id():
    """Call sites pass asset.project_id straight through, which is a UUID."""
    import uuid
    pid = uuid.uuid4()
    fake = MagicMock()
    with patch.object(event_service, "_get_sync_redis", return_value=fake):
        event_service.publish_sync(pid, "approval_updated", {"status": "approved"})

    assert fake.publish.call_args[0][0] == f"project:{pid}"


def test_publish_sync_swallows_a_broker_failure():
    """A live update is not worth failing the request that produced it.

    Every call site publishes after commit, so raising here would turn a
    succeeded write into a 500 for the client.
    """
    fake = MagicMock()
    fake.publish.side_effect = ConnectionError("redis is down")
    with patch.object(event_service, "_get_sync_redis", return_value=fake), \
         patch.object(event_service.logger, "warning") as warn:
        assert event_service.publish_sync("proj-1", "new_comment", {"comment_id": "c-1"}) is False
    # asserted so a regression to a bare `except: pass` fails here rather than
    # leaving a broker outage invisible in production
    assert warn.called


def test_publish_sync_swallows_a_connection_setup_failure():
    """The pool is built lazily, so the first call can fail before publish()."""
    with patch.object(event_service, "_get_sync_redis", side_effect=OSError("no route to host")):
        assert event_service.publish_sync("proj-1", "transcode_failed", {"error": "boom"}) is False


# ── ffmpeg progress parsing ───────────────────────────────────────────────────

@pytest.mark.parametrize(
    "line,duration,expected",
    [
        ("out_time_us=0", 100.0, 0),
        ("out_time_us=50000000", 100.0, 50),
        ("out_time_us=99000000", 100.0, 99),
        ("out_time_us=1000000", 4.0, 25),
        ("  out_time_us=50000000  \n", 100.0, 50),  # ffmpeg pads and newline-terminates
    ],
)
def test_parse_progress_percent_maps_position_to_percent(line, duration, expected):
    assert parse_progress_percent(line, duration) == expected


def test_progress_end_is_the_only_source_of_100():
    assert parse_progress_percent("progress=end", 100.0) == 100
    # even past the nominal duration, a position line stays below 100 so a
    # rounding error or a slightly wrong duration cannot report done early
    assert parse_progress_percent("out_time_us=999000000", 100.0) == 99


def test_progress_end_does_not_need_a_duration():
    """Duration probing can fail; completion is still knowable."""
    assert parse_progress_percent("progress=end", None) == 100
    assert parse_progress_percent("progress=end", 0) == 100


@pytest.mark.parametrize(
    "line",
    [
        "out_time_us=N/A",       # emitted before the first frame is written
        "bitrate= 1234.5kbits/s",
        "frame=42",
        "",
        "progress=continue",
    ],
)
def test_parse_progress_percent_ignores_everything_else(line):
    assert parse_progress_percent(line, 100.0) is None


@pytest.mark.parametrize("duration", [None, 0, -1])
def test_parse_progress_percent_needs_a_usable_duration(duration):
    """Without a duration a position is meaningless, so report nothing."""
    assert parse_progress_percent("out_time_us=50000000", duration) is None


def test_parse_progress_percent_ignores_negative_position():
    assert parse_progress_percent("out_time_us=-1", 100.0) is None


def test_run_with_progress_emits_a_strictly_increasing_series(tmp_path):
    """The throttling contract, exercised through the real runner.

    ffmpeg emits a progress block about twice a second; without throttling a
    feature-length file would be thousands of Redis publishes. The runner must
    forward each whole percent at most once, and never go backwards.
    """
    fake = tmp_path / "fake_ffmpeg.sh"
    fake.write_text(
        "#!/bin/sh\n"
        # same percent repeated, then a jump, then a stale lower reading
        "printf 'out_time_us=1000000\\n'"
        "; printf 'out_time_us=1400000\\n'"
        "; printf 'out_time_us=9000000\\n'"
        "; printf 'out_time_us=2000000\\n'"
        "; printf 'progress=end\\n'\n"
    )
    fake.chmod(0o755)

    seen = []
    _transcoder()._run_with_progress(
        [str(fake)], timeout=30, duration_seconds=100.0, on_percent=seen.append,
    )

    assert seen == sorted(seen), "progress must never run backwards"
    assert len(seen) == len(set(seen)), "each percent must be sent at most once"
    assert seen[-1] == 100, "progress=end must close the series at 100"


def test_run_with_progress_bounds_a_child_that_never_exits(tmp_path):
    """The 4-hour ceiling has to hold even when the pipe stays open.

    Killing ffmpeg does not necessarily close stdout -- anything that inherited
    the descriptor keeps it open -- so a naive `for line in proc.stdout` would
    block forever and strand the worker slot. This is the regression guard.
    """
    fake = tmp_path / "hung_ffmpeg.sh"
    fake.write_text(
        "#!/bin/sh\nprintf 'out_time_us=1000000\\n'\nsleep 60\n"
    )
    fake.chmod(0o755)

    started = time.monotonic()
    with pytest.raises(subprocess.TimeoutExpired):
        _transcoder()._run_with_progress(
            [str(fake)], timeout=2, duration_seconds=100.0, on_percent=lambda p: None,
        )
    assert time.monotonic() - started < 30, "timeout must actually bound the read"


def test_run_with_progress_reports_failure_the_way_run_does(tmp_path):
    """Hardware fallback matches on the exception message, so keep its shape.

    The HLS call site catches RuntimeError and inspects the text to decide
    whether to retry on the software backend. A different type or a swallowed
    stderr would silently disable that fallback.
    """
    fake = tmp_path / "failing_ffmpeg.sh"
    fake.write_text(
        "#!/bin/sh\n"
        "printf 'out_time_us=1000000\\n'\n"
        "echo 'Conversion failed! CUDA_ERROR_OUT_OF_MEMORY' >&2\n"
        "exit 1\n"
    )
    fake.chmod(0o755)

    with pytest.raises(RuntimeError) as exc:
        _transcoder()._run_with_progress(
            [str(fake)], timeout=30, duration_seconds=100.0, on_percent=lambda p: None,
        )
    assert "CUDA_ERROR_OUT_OF_MEMORY" in str(exc.value), "stderr must survive"
    assert _is_hw_runtime_failure(str(exc.value)), "hardware fallback must still match"


def test_a_raising_listener_does_not_fail_the_transcode(tmp_path):
    """Progress is cosmetic. A broken consumer must not lose someone's upload."""
    fake = tmp_path / "ok_ffmpeg.sh"
    fake.write_text("#!/bin/sh\nprintf 'out_time_us=5000000\\n'\nprintf 'progress=end\\n'\n")
    fake.chmod(0o755)

    def explode(_percent):
        raise RuntimeError("listener is broken")

    _transcoder()._run_with_progress(
        [str(fake)], timeout=30, duration_seconds=100.0, on_percent=explode,
    )


# ── the route handlers actually publish ───────────────────────────────────────

def test_resolve_comment_publishes_the_resulting_state():
    """The endpoint toggles, so the event must carry the state it toggled to."""
    from apps.api.routers import comments as comments_router

    project_id, asset_id, comment_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    comment = SimpleNamespace(id=comment_id, asset_id=asset_id, resolved=False, deleted_at=None)
    asset = SimpleNamespace(id=asset_id, project_id=project_id, deleted_at=None)
    user = SimpleNamespace(id=uuid.uuid4(), name="Alice")

    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.first.return_value = comment

    with patch.object(comments_router, "_get_asset", return_value=asset), \
         patch.object(comments_router, "require_asset_access"), \
         patch.object(comments_router, "_build_comment_response", return_value={}), \
         patch.object(comments_router.event_service, "publish_sync") as pub:
        comments_router.resolve_comment(comment_id, db=db, current_user=user)

    pid, event, payload = pub.call_args[0]
    assert pid == project_id
    assert event == "comment_resolved"
    assert payload == {"comment_id": str(comment_id), "resolved": True}


def test_approve_asset_publishes_approval_updated():
    from apps.api.routers import approvals as approvals_router

    project_id, asset_id = uuid.uuid4(), uuid.uuid4()
    user = SimpleNamespace(id=uuid.uuid4(), name="Alice", email="a@example.com")
    asset = SimpleNamespace(id=asset_id, project_id=project_id, name="clip", created_by=user.id)
    body = SimpleNamespace(version_id=uuid.uuid4(), note=None)

    with patch.object(approvals_router, "_get_asset", return_value=asset), \
         patch.object(approvals_router, "require_project_role"), \
         patch.object(approvals_router, "_upsert_approval", return_value=SimpleNamespace()), \
         patch.object(approvals_router.event_service, "publish_sync") as pub:
        approvals_router.approve_asset(asset_id, body, db=MagicMock(), current_user=user)

    pid, event, payload = pub.call_args[0]
    assert pid == project_id
    assert event == "approval_updated"
    assert payload == {
        "asset_id": str(asset_id),
        "user_id": str(user.id),
        "status": "approved",
    }


def test_process_video_wires_progress_into_the_transcode_job():
    """Without progress_cb set, the transcoder silently takes the non-progress
    path and transcode_progress is never emitted again."""
    from packages.transcoder.base import TranscodeJob

    job = TranscodeJob(
        media_id="m", version_id="v", input_s3_key="k", output_s3_prefix="p",
    )
    assert job.progress_cb is None, "must stay optional for other backends"

    src = Path("apps/api/tasks/transcode_tasks.py").read_text()
    assert "progress_cb=_on_progress" in src, "the video task must pass a progress callback"
