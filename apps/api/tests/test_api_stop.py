"""A container stop has to reach gunicorn, and open event streams must not hold it up.

`sh -c "... && gunicorn"` leaves the shell as the container's main process, and dash
does not forward SIGTERM. With the signal delivered, uvicorn waits for open responses
before it exits, and an event stream never ends on its own.
"""
import asyncio
import os
import shlex
import signal
from pathlib import Path

import pytest
import yaml

from apps.api.main import app, lifespan
from apps.api.services import event_service

PROD_COMPOSE = Path(__file__).resolve().parents[3] / "docker-compose.prod.yml"
WAIT = 5  # far below the 30 s keepalive that would otherwise wake an idle stream


class _PubSub:
    """Blocks in get_message for its whole timeout, as an idle channel does."""

    def __init__(self):
        self.queue: asyncio.Queue = asyncio.Queue()
        self.unsubscribed = self.closed = False

    async def subscribe(self, channel):
        pass

    async def get_message(self, ignore_subscribe_messages=False, timeout=0.0):
        try:
            return await asyncio.wait_for(self.queue.get(), timeout)
        except asyncio.TimeoutError:
            return None

    async def unsubscribe(self, channel):
        self.unsubscribed = True

    async def aclose(self):
        self.closed = True


@pytest.fixture
def pubsub(monkeypatch):
    made = []

    class _Redis:
        def pubsub(self):
            made.append(_PubSub())
            return made[-1]

    monkeypatch.setattr(event_service, "_get_redis", _Redis)
    yield made
    event_service.allow_streams()


async def _allowed():
    return None


def _open():
    return event_service.event_stream("p", _allowed, max_auth_age_seconds=60, recheck_seconds=60)


async def _collect(stream, got):
    async for chunk in stream:
        got.append(chunk)


def test_an_idle_stream_ends_when_the_server_stops(pubsub):
    async def go():
        got = []
        task = asyncio.create_task(_collect(_open(), got))
        await asyncio.sleep(0.1)
        assert not task.done()
        event_service.end_streams()
        await asyncio.wait_for(task, WAIT)
        return got

    assert asyncio.run(go()) == []  # no `revoked`: the client should reconnect
    assert pubsub[0].unsubscribed and pubsub[0].closed
    assert not event_service._open_streams


def test_every_open_stream_ends_and_a_late_one_does_not_start(pubsub):
    async def go():
        tasks = [asyncio.create_task(_collect(_open(), [])) for _ in range(3)]
        await asyncio.sleep(0.1)
        event_service.end_streams()
        await asyncio.wait_for(asyncio.gather(*tasks), WAIT)
        await asyncio.wait_for(_collect(_open(), []), WAIT)

    asyncio.run(go())
    assert len(pubsub) == 4 and all(p.closed for p in pubsub)


def test_a_stream_delivers_events_until_then(pubsub):
    async def go():
        got = []
        task = asyncio.create_task(_collect(_open(), got))
        await asyncio.sleep(0.1)
        pubsub[0].queue.put_nowait({"type": "message", "data": event_service._encode("x", {"a": 1})})
        await asyncio.sleep(0.1)
        event_service.end_streams()
        await asyncio.wait_for(task, WAIT)
        return got

    assert asyncio.run(go()) == ['event: x\ndata: {"a": 1}\n\n']


def test_a_busy_stream_ends_too(pubsub, monkeypatch):
    """With a message always ready, the read never loses to the stop."""
    async def always(self, **kwargs):
        await asyncio.sleep(0)
        return {"type": "message", "data": event_service._encode("x", {})}

    monkeypatch.setattr(_PubSub, "get_message", always)

    async def go():
        task = asyncio.create_task(_collect(_open(), []))
        await asyncio.sleep(0.1)
        event_service.end_streams()
        await asyncio.wait_for(task, WAIT)

    asyncio.run(go())


def test_a_stream_whose_client_leaves_is_forgotten(pubsub):
    async def go():
        task = asyncio.create_task(_collect(_open(), []))
        await asyncio.sleep(0.1)
        assert len(event_service._open_streams) == 1
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        left = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
        await asyncio.sleep(0)
        return [t for t in left if not t.done()]

    assert asyncio.run(go()) == []
    assert not event_service._open_streams and pubsub[0].closed


def test_a_failing_read_still_raises(pubsub, monkeypatch):
    async def broken(self, **kwargs):
        raise ConnectionError("redis is gone")

    monkeypatch.setattr(_PubSub, "get_message", broken)
    with pytest.raises(ConnectionError):
        asyncio.run(_collect(_open(), []))
    assert not event_service._open_streams and pubsub[0].closed


@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGINT])
def test_the_stop_signal_ends_streams_and_still_reaches_the_server(pubsub, monkeypatch, sig):
    monkeypatch.setattr("apps.api.main.run_startup_bucket_setup", lambda: None)
    received = []

    def server_handler(signum, frame):
        received.append(signum)

    async def go():
        async with lifespan(app):
            task = asyncio.create_task(_collect(_open(), []))
            await asyncio.sleep(0.1)
            os.kill(os.getpid(), sig)
            await asyncio.wait_for(task, WAIT)

    before = signal.signal(sig, server_handler)
    try:
        asyncio.run(go())
        assert received == [sig]
        assert signal.getsignal(sig) is server_handler  # put back
    finally:
        signal.signal(sig, before)


def test_a_signal_nobody_handles_is_left_alone(pubsub, monkeypatch):
    """Taking over a default handler would make the process ignore the stop."""
    monkeypatch.setattr("apps.api.main.run_startup_bucket_setup", lambda: None)

    async def go():
        async with lifespan(app):
            return signal.getsignal(signal.SIGTERM)

    before = signal.signal(signal.SIGTERM, signal.SIG_DFL)
    try:
        assert asyncio.run(go()) is signal.SIG_DFL
    finally:
        signal.signal(signal.SIGTERM, before)


def test_starting_again_allows_streams(pubsub, monkeypatch):
    monkeypatch.setattr("apps.api.main.run_startup_bucket_setup", lambda: None)
    event_service.end_streams()

    async def go():
        async with lifespan(app):
            return event_service._stopping

    assert asyncio.run(go()) is False


def test_gunicorn_replaces_the_shell():
    if not PROD_COMPOSE.is_file():
        pytest.skip("docker-compose.prod.yml not present (not a full checkout)")
    command = yaml.safe_load(PROD_COMPOSE.read_text())["services"]["api"]["command"]
    tokens = shlex.split(shlex.split(command)[2])
    assert tokens[tokens.index("gunicorn") - 1] == "exec"
