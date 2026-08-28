"""Redis-backed SSE event bus for cross-process real-time events."""
import asyncio
import json
import logging
from typing import AsyncGenerator
import redis as sync_redis
import redis.asyncio as aioredis
from ..config import settings

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


async def event_stream(project_id: str) -> AsyncGenerator[str, None]:
    """Subscribe to a Redis channel and yield SSE messages."""
    r = _get_redis()
    pubsub = r.pubsub()
    await pubsub.subscribe(f"project:{project_id}")
    try:
        while True:
            try:
                message = await asyncio.wait_for(pubsub.get_message(ignore_subscribe_messages=True), timeout=30.0)
                if message and message["type"] == "message":
                    try:
                        parsed = json.loads(message["data"])
                        event_type = parsed.get("type", "message")
                        payload = json.dumps(parsed.get("payload", parsed))
                        yield f"event: {event_type}\ndata: {payload}\n\n"
                    except (json.JSONDecodeError, TypeError):
                        yield f"data: {message['data']}\n\n"
                else:
                    yield ": keepalive\n\n"
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
    finally:
        await pubsub.unsubscribe(f"project:{project_id}")
        await pubsub.aclose()
