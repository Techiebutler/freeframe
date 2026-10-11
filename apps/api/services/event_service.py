"""Redis-backed SSE event bus for cross-process real-time events."""
import asyncio
import json
import logging
import time
from typing import AsyncGenerator, Awaitable, Callable, Optional
import redis as sync_redis
import redis.asyncio as aioredis
from ..config import settings
from .permissions import EVENTS_TOKEN_EXPIRED

logger = logging.getLogger(__name__)

_pool = None
_sync_pool = None


def _channel(project_id) -> str:
    return f"project:{project_id}"


def _encode(event_type: str, payload: dict) -> str:
    return json.dumps({"type": event_type, "payload": payload})


def _get_redis():
    global _pool
    if _pool is None:
        _pool = aioredis.ConnectionPool.from_url(settings.redis_url, decode_responses=True)
    return aioredis.Redis(connection_pool=_pool)


# Publishing happens inline in request handlers and, for transcode progress,
# inside the loop draining ffmpeg's stdout. A broker that accepts the connection
# but never answers would otherwise block those callers indefinitely: a request
# would hang after its write had already committed, and a transcode would stall
# once ffmpeg's stdout pipe filled up behind the blocked reader. Bound both.
_PUBLISH_TIMEOUT_SECONDS = 2.0


def _get_sync_redis():
    global _sync_pool
    if _sync_pool is None:
        _sync_pool = sync_redis.ConnectionPool.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_timeout=_PUBLISH_TIMEOUT_SECONDS,
            socket_connect_timeout=_PUBLISH_TIMEOUT_SECONDS,
        )
    return sync_redis.Redis(connection_pool=_sync_pool)


async def publish(project_id: str, event_type: str, payload: dict) -> None:
    """Publish an event to a Redis channel for the project."""
    r = _get_redis()
    await r.publish(_channel(project_id), _encode(event_type, payload))


def publish_sync(project_id, event_type: str, payload: dict) -> bool:
    """Publish from synchronous context: request handlers and Celery workers.

    Every route in this app is a sync ``def``, so ``publish`` above cannot be
    awaited from one. This is the emit path those call sites use.

    Best-effort by design. A real-time notification is not worth failing the
    request that produced it, so a broker that is down or slow degrades to
    "no live update, refresh to see it" rather than a 500. The connection is
    pooled, so this is one round trip, not a new connection per event.

    Returns True if the event reached the broker. A caller publishing in a hot
    loop can use that to stop trying rather than pay the timeout on every event.
    """
    try:
        _get_sync_redis().publish(_channel(project_id), _encode(event_type, payload))
        return True
    except Exception:
        logger.warning(
            "SSE publish failed for %s on project %s", event_type, project_id, exc_info=True
        )
        return False


def _format(data) -> str:
    try:
        parsed = json.loads(data)
        event_type = parsed.get("type", "message")
        payload = json.dumps(parsed.get("payload", parsed))
        return f"event: {event_type}\ndata: {payload}\n\n"
    except (json.JSONDecodeError, TypeError, AttributeError):
        return f"data: {data}\n\n"


# Upper bound on the gap between two writes to an idle stream. Reverse proxies
# close a connection that sends nothing for their read timeout (60 s by default
# in nginx), so the keepalive does not follow SSE_AUTH_RECHECK_SECONDS past this.
KEEPALIVE_MAX_SECONDS = 30.0


def _revoked(reason: str) -> str:
    return f"event: revoked\ndata: {json.dumps({'reason': reason})}\n\n"


async def event_stream(
    project_id: str,
    authorize: Callable[[], Awaitable[Optional[str]]],
    *,
    max_auth_age_seconds: float,
    recheck_seconds: float,
    expires_at: Optional[float] = None,
    checked_at: Optional[float] = None,
) -> AsyncGenerator[str, None]:
    """Subscribe to a project's channel and yield SSE messages for as long as
    the subscriber stays authorized.

    `authorize` returns None while the subscriber may still receive this
    project's events, or a short reason once it may not. The caller has just
    run it to accept the connection, at `checked_at` (event-loop time; defaults
    to now). It is run again:

    - before an event is delivered, whenever the last check is older than
      `max_auth_age_seconds`, so nothing is sent on a stale decision;
    - every `recheck_seconds` while no events arrive, so an idle stream is
      closed too.

    `expires_at` is the access token's `exp` (Unix time). It is compared before
    every single write, not only on the gated check, so nothing is sent after
    the token expires.

    An idle stream gets a keepalive comment every `recheck_seconds`, or every
    KEEPALIVE_MAX_SECONDS if that is shorter.

    Once a check gives a reason, the stream sends a final `revoked` event
    carrying it and ends. If the check itself fails (the database is down) the
    stream ends without one, and the client's reconnect gets a fresh decision.
    """
    keepalive_seconds = min(recheck_seconds, KEEPALIVE_MAX_SECONDS)
    r = _get_redis()
    pubsub = r.pubsub()
    await pubsub.subscribe(_channel(project_id))
    loop = asyncio.get_running_loop()
    if checked_at is None:
        checked_at = loop.time()
    sent_at = loop.time()
    try:
        while True:
            now = loop.time()
            wake_at = min(checked_at + recheck_seconds, sent_at + keepalive_seconds)
            if expires_at is not None:
                wake_at = min(wake_at, now + (expires_at - time.time()))
            # get_message's timeout defaults to 0, which returns at once when
            # nothing is waiting; without an explicit one the loop would not wait.
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=max(0.0, wake_at - now))
            is_event = message is not None and message.get("type") == "message"

            age = loop.time() - checked_at
            if age >= recheck_seconds or (is_event and age >= max_auth_age_seconds):
                try:
                    reason = await authorize()
                except Exception:
                    logger.warning("SSE re-authorization failed for project %s; closing the stream",
                                   project_id, exc_info=True)
                    return
                checked_at = loop.time()
                if reason:
                    yield _revoked(reason)
                    return

            # Exact, unlike the gated check above: never write after `exp`.
            if expires_at is not None and time.time() >= expires_at:
                yield _revoked(EVENTS_TOKEN_EXPIRED)
                return

            if is_event:
                yield _format(message["data"])
                sent_at = loop.time()
            elif loop.time() - sent_at >= keepalive_seconds:
                yield ": keepalive\n\n"
                sent_at = loop.time()
    finally:
        await pubsub.unsubscribe(_channel(project_id))
        await pubsub.aclose()
