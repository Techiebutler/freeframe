"""`send_task_safe` dispatches on a bounded pool of joined threads (issue #274).

It used to start a new daemon thread per call: a burst of dispatches opened one
thread (and one broker connection, broker_pool_limit=0) each, and a dispatch still
in flight at interpreter exit was killed instead of finished.
"""
import threading
import time
from unittest.mock import MagicMock

from apps.api.tasks import celery_app as celery_module
from apps.api.tasks.celery_app import send_task_safe


def _wait_until(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def test_burst_of_dispatches_runs_on_a_bounded_pool(monkeypatch):
    release = threading.Event()
    lock = threading.Lock()
    running = set()
    done = []

    def blocking_dispatch(task, args, kwargs):
        with lock:
            running.add(threading.get_ident())
        release.wait(timeout=10)
        with lock:
            done.append(args)

    monkeypatch.setattr(celery_module, "_dispatch_task", blocking_dispatch)

    try:
        for i in range(20):
            send_task_safe(MagicMock(), i)

        # With every dispatch blocked, the number that got a thread to themselves
        # is the number of threads in use.
        assert _wait_until(lambda: len(running) >= 4)
        time.sleep(0.2)
        assert len(running) <= 4
    finally:
        release.set()

    # The queued dispatches are not dropped: all of them run once a slot frees.
    assert _wait_until(lambda: len(done) == 20)
    assert sorted(a[0] for a in done) == list(range(20))


# Dispatches slow enough to still be pending when the interpreter exits. They are
# submitted from a daemon thread, as FastAPI's sync route handlers are, so the
# test also covers pool workers that inherit the daemon flag.
_EXIT_SCRIPT = """
import threading, time
from apps.api.tasks import celery_app as m

def slow_dispatch(task, args, kwargs):
    time.sleep(0.5)
    print("dispatched", args[0], flush=True)

m._dispatch_task = slow_dispatch

def handler():
    for i in range(6):
        m.send_task_safe(None, i)

t = threading.Thread(target=handler, daemon=True)
t.start()
t.join()
print("exiting", flush=True)
"""


def test_pending_dispatches_finish_before_interpreter_exit():
    import os
    import subprocess
    import sys
    from pathlib import Path

    repo_root = Path(__file__).resolve().parents[3]
    result = subprocess.run(
        [sys.executable, "-c", _EXIT_SCRIPT],
        cwd=repo_root,
        env={**os.environ, "PYTHONPATH": str(repo_root)},
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert result.returncode == 0, result.stderr
    lines = result.stdout.splitlines()
    assert "exiting" in lines
    # A daemon thread per dispatch was killed at exit, so none of these printed.
    assert sorted(line for line in lines if line.startswith("dispatched")) == [
        f"dispatched {i}" for i in range(6)
    ]


def test_dispatch_failure_is_logged_not_raised(caplog):
    task = MagicMock()
    task.name = "fake_task"
    task.delay.side_effect = RuntimeError("broker exploded")

    with caplog.at_level("WARNING", logger="celery.dispatch"):
        send_task_safe(task, "x")
        assert _wait_until(
            lambda: any("Failed to dispatch task fake_task" in r.getMessage() for r in caplog.records)
        )

    task.delay.assert_called_once_with("x")
