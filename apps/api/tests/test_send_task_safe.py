"""`send_task_safe` dispatches on a bounded pool of joined threads (issue #274).

It used to start a new daemon thread per call: a burst of dispatches opened one
thread (and one broker connection, broker_pool_limit=0) each, and a dispatch still
in flight at interpreter exit was killed instead of finished. With a bounded pool,
a dispatch that hangs on an unresponsive Redis must time out, or four of them
would stall every later one.
"""
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock

from apps.api.tasks import celery_app as celery_module
from apps.api.tasks.celery_app import send_task_safe


_REPO_ROOT = Path(__file__).resolve().parents[3]


def _run_script(script, timeout, **env):
    return subprocess.run(
        [sys.executable, "-c", script],
        cwd=_REPO_ROOT,
        env={**os.environ, "PYTHONPATH": str(_REPO_ROOT), **env},
        capture_output=True,
        text=True,
        timeout=timeout,
    )


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
    result = _run_script(_EXIT_SCRIPT, timeout=60)

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
    task.apply_async.side_effect = RuntimeError("broker exploded")

    with caplog.at_level("WARNING", logger="celery.dispatch"):
        send_task_safe(task, "x")
        assert _wait_until(
            lambda: any("Failed to dispatch task fake_task" in r.getMessage() for r in caplog.records)
        )

    task.apply_async.assert_called_once_with(args=("x",), kwargs={}, ignore_result=True)


# Real dispatches of a real task against a Redis that accepts connections and
# never answers (paused, or a network blackhole). Four of them fill the pool, and
# a mock dispatch queued behind them has to run once they time out. The script
# then returns, so the interpreter must also be able to exit.
_HUNG_BROKER_SCRIPT = """
import logging, time
from unittest.mock import MagicMock
from apps.api.tasks import celery_app as m

logging.basicConfig(level=logging.WARNING)

@m.celery_app.task(name="hung_broker_probe")
def probe():
    pass

for _ in range(4):
    m.send_task_safe(probe)
queued = MagicMock()
m.send_task_safe(queued)

deadline = time.monotonic() + 40
while not queued.apply_async.called and time.monotonic() < deadline:
    time.sleep(0.05)
print("queued dispatch ran:", queued.apply_async.called, flush=True)
"""


def test_unresponsive_broker_does_not_stall_later_dispatches():
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(16)
    server.settimeout(0.2)
    port = server.getsockname()[1]
    accepted = []
    stop = threading.Event()

    def accept_and_never_reply():
        while not stop.is_set():
            try:
                conn, _ = server.accept()
            except socket.timeout:
                continue
            accepted.append(conn)

    acceptor = threading.Thread(target=accept_and_never_reply, daemon=True)
    acceptor.start()
    try:
        result = _run_script(_HUNG_BROKER_SCRIPT, timeout=60, REDIS_URL=f"redis://127.0.0.1:{port}/0")
    finally:
        stop.set()
        acceptor.join(timeout=5)
        for conn in accepted:
            conn.close()
        server.close()

    assert result.returncode == 0, result.stderr
    assert accepted, "the dispatches never reached the fake broker"
    assert "queued dispatch ran: True" in result.stdout
    # The four hung dispatches gave up through the logged path instead of hanging.
    assert result.stderr.count("Failed to dispatch task hung_broker_probe") == 4
