"""A Redis that stops answering must not stop the API (#660).

It accepts the connection and then says nothing: a paused container, a network
blackhole. The client had no timeout and the global rate limiter called it on the
event loop, so one such Redis stopped every request, /health included.
"""
import asyncio
import socket
import threading
import time
from types import SimpleNamespace

import pytest
import redis
from fastapi import Depends
from fastapi.testclient import TestClient

from apps.api.main import app
from apps.api.middleware.global_rate_limit import GlobalRateLimitMiddleware
from apps.api.services import redis_service

ORIGIN = "http://localhost:3000"


def _probe_dependency():
    return None


def _probe(_=Depends(_probe_dependency)):
    return {}


@pytest.fixture
def silent_redis(monkeypatch):
    """A server that accepts and never answers, and a client pointed at it."""
    server = socket.create_server(("127.0.0.1", 0))
    taken = []

    def accept():
        while True:
            try:
                taken.append(server.accept()[0])
            except OSError:
                return

    threading.Thread(target=accept, daemon=True).start()
    monkeypatch.setattr(redis_service.settings, "redis_url", f"redis://127.0.0.1:{server.getsockname()[1]}/0")
    monkeypatch.setattr(redis_service, "REDIS_TIMEOUT_SECONDS", 0.2)
    monkeypatch.setattr(redis_service, "_redis_client", None)
    monkeypatch.setattr(redis_service, "_limiter_paused_until", 0.0)
    yield taken
    server.close()
    for sock in taken:
        sock.close()


def _within(seconds, call):
    """Run `call` in a thread and fail, rather than hang, if it does not return."""
    out = {}

    def go():
        try:
            out["value"] = call()
        except Exception as exc:
            out["error"] = exc

    thread = threading.Thread(target=go, daemon=True)
    thread.start()
    thread.join(seconds)
    assert not thread.is_alive(), f"still waiting after {seconds} s"
    return out


def test_a_command_gives_up(silent_redis):
    out = _within(3, lambda: redis_service.get_redis().get("x"))
    assert isinstance(out["error"], redis.exceptions.TimeoutError)


def test_both_timeouts_are_set(monkeypatch):
    monkeypatch.setattr(redis_service, "_redis_client", None)
    kwargs = redis_service.get_redis().connection_pool.connection_kwargs
    assert kwargs["socket_timeout"] == kwargs["socket_connect_timeout"] == redis_service.REDIS_TIMEOUT_SECONDS == 2.0
    monkeypatch.setattr(redis_service, "_redis_client", None)


class TestLimiters:
    def test_the_route_limiter_lets_the_request_through(self, silent_redis):
        assert _within(3, lambda: redis_service.check_rate_limit("ip", "a", 1, 60))["value"] == (True, 0)

    def test_the_route_limiter_asks_every_time(self, silent_redis):
        """It guards sign-in: it must count again as soon as Redis answers."""
        _within(3, lambda: redis_service.check_rate_limit("ip", "a", 1, 60))
        asked = len(silent_redis)
        _within(3, lambda: redis_service.check_rate_limit("ip", "a", 1, 60))
        assert len(silent_redis) > asked >= 1
        assert not redis_service.limiter_paused()

    def test_a_timeout_pauses_the_global_one(self, silent_redis):
        middleware = GlobalRateLimitMiddleware(app=None)
        assert _within(3, lambda: middleware._check("ip:x", "global_r", 1))["value"] == (True, 0)
        assert redis_service.limiter_paused()

    def test_it_asks_again_once_the_pause_is_over(self, silent_redis, monkeypatch):
        monkeypatch.setattr(redis_service, "LIMITER_PAUSE_SECONDS", 0.1)
        _within(3, lambda: GlobalRateLimitMiddleware(app=None)._check("ip:x", "global_r", 1))
        assert redis_service.limiter_paused()
        time.sleep(0.15)
        assert not redis_service.limiter_paused()

    def test_a_refused_connection_does_not_pause_it(self, silent_redis, monkeypatch):
        monkeypatch.setattr(redis_service.settings, "redis_url", "redis://127.0.0.1:1/0")
        assert GlobalRateLimitMiddleware(app=None)._check("ip:x", "global_r", 1) == (True, 0)
        assert not redis_service.limiter_paused()


class TestTheGlobalLimiter:
    REQUEST = SimpleNamespace(
        url=SimpleNamespace(path="/projects"), method="GET", headers={}, client=SimpleNamespace(host="1.2.3.4"),
    )

    def _dispatch(self, middleware, times=1):
        async def call_next(request):
            return "answered"

        async def go():
            return await asyncio.gather(*(middleware.dispatch(self.REQUEST, call_next) for _ in range(times)))

        out = _within(10, lambda: asyncio.run(go()))
        assert "error" not in out, out
        return out["value"]

    def test_a_burst_waits_once_on_one_connection(self, silent_redis):
        started = time.monotonic()
        assert self._dispatch(GlobalRateLimitMiddleware(app=None), 400) == ["answered"] * 400
        assert time.monotonic() - started < 1.5  # one timeout of 0.2 s, not 400
        assert len(silent_redis) == 1

    def test_while_paused_redis_is_not_asked(self, monkeypatch):
        monkeypatch.setattr(redis_service, "_limiter_paused_until", time.monotonic() + 60)
        middleware = GlobalRateLimitMiddleware(app=None)
        monkeypatch.setattr(middleware, "_check", lambda *a: pytest.fail("asked Redis"))
        assert self._dispatch(middleware) == ["answered"]

    def test_a_refusal_still_reaches_the_client(self, monkeypatch):
        monkeypatch.setattr(redis_service, "_limiter_paused_until", 0.0)
        middleware = GlobalRateLimitMiddleware(app=None)
        monkeypatch.setattr(middleware, "_check", lambda *a: (False, 7))
        [answer] = self._dispatch(middleware)
        assert answer.status_code == 429 and answer.headers["retry-after"] == "7"


def test_health_needs_no_thread():
    [route] = [r for r in app.router.routes if getattr(r, "path", "") == "/health"]
    assert asyncio.iscoroutinefunction(route.endpoint)


class TestWhatNeedsRedis:
    @pytest.mark.parametrize("error", [
        redis.exceptions.TimeoutError("Timeout reading from socket"),
        redis.exceptions.ConnectionError("Connection refused"),
        redis.exceptions.BusyLoadingError("loading"),
    ])
    def test_answers_503_that_a_browser_can_read(self, monkeypatch, error):
        def fail():
            raise error

        monkeypatch.setitem(app.dependency_overrides, _probe_dependency, fail)
        app.add_api_route("/zz-redis-probe", _probe, methods=["GET"])
        try:
            response = TestClient(app).get("/zz-redis-probe", headers={"Origin": ORIGIN})
        finally:
            app.router.routes[:] = [r for r in app.router.routes if getattr(r, "path", "") != "/zz-redis-probe"]
        assert response.status_code == 503
        assert response.json() == {"detail": "The server is not answering right now. Try again in a moment."}
        assert response.headers["retry-after"] == "5"
        assert "access-control-allow-origin" in response.headers
