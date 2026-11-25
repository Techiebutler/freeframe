"""Outgoing webhook: tell an outside system a version is ready (or failed).

Instance-level and off unless WEBHOOK_URL is set. The transcode task announces
`transcode_complete` and `transcode_failed` on the SSE bus; this is a second sink
on the same two facts, delivered by a Celery task on its own `webhooks` queue so
an endpoint that is slow, wedged or gone can never reach back into a transcode.

The body is built from the database when the task runs, not from the SSE event,
so it can say where the asset lives (project, folder path) and what it is called.
It carries no secret and no presigned URL: a receiver that wants the file asks
the API with its own credentials.

Headers: X-FreeFrame-Event, X-FreeFrame-Delivery (the same id on every retry,
so a receiver can drop the duplicate) and, with WEBHOOK_SECRET set,
X-FreeFrame-Signature: sha256=<HMAC-SHA256 of the raw body>. `delivered_at` is
inside the signed body, which bounds replay.
"""
import hashlib
import hmac
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlsplit

import httpx
from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded
from sqlalchemy.exc import SQLAlchemyError

from ..config import settings
from ..database import SessionLocal
from ..models.asset import Asset, AssetVersion
from ..models.folder import Folder
from ..models.project import Project
from ..services.folder_paths import MAX_DEPTH_WALK
from ..services.permissions import folder_chain_is_live

log = logging.getLogger("celery.webhook")
# httpx logs every request URL at INFO, and the URL may carry a token.
logging.getLogger("httpx").setLevel(logging.WARNING)

#: Events WEBHOOK_EVENTS can name, and the version status each reports.
WEBHOOK_EVENT_NAMES = {
    "transcode_complete": "ready",
    "transcode_failed": "failed",
}

#: Seconds the receiver gets to connect, to take the request and to send each
#: chunk of the answer. Each step has its own timer, so it does not bound a whole
#: attempt: SOFT_TIME_LIMIT does.
REQUEST_TIMEOUT = 10.0
#: Seconds one attempt may run in all before it counts as a timeout (and is
#: retried), and the hard limit that kills the process if that is ignored. The
#: hard limit is generous because psycopg2 blocks in C: the soft limit is not
#: seen until a stuck query returns, and a tight hard limit would lose the
#: delivery with no retry.
SOFT_TIME_LIMIT = 15
HARD_TIME_LIMIT = 120
#: Attempts after the first. Backoff doubles from 30s: 30, 60, 120, 240, 480.
MAX_RETRIES = 5
RETRY_BASE_SECONDS = 30
#: A 4xx other than these will not get better by asking again.
RETRYABLE_CLIENT_ERRORS = {408, 425, 429}


def enabled_events() -> set[str]:
    """The events WEBHOOK_EVENTS asks for; an unknown name is logged and ignored."""
    names = {n.strip() for n in settings.webhook_events.split(",") if n.strip()}
    for unknown in sorted(names - WEBHOOK_EVENT_NAMES.keys()):
        log.warning("WEBHOOK_EVENTS names an unknown event %r; ignored", unknown)
    return names & WEBHOOK_EVENT_NAMES.keys()


def _valid_url(url: str) -> bool:
    """True for an http(s) URL with a host. Anything else is a typo, and would
    otherwise crash every delivery or retry it for 15 minutes."""
    try:
        parts = urlsplit(url)
        return parts.scheme in ("http", "https") and bool(parts.hostname)
    except ValueError:
        return False


def enqueue_webhook(event: str, asset_id: str, version_id: str) -> bool:
    """Queue a delivery if a webhook is configured for `event`. True if queued."""
    url = settings.webhook_url.strip()
    if not url or event not in enabled_events():
        return False
    if not _valid_url(url):
        log.warning("WEBHOOK_URL is not an http(s) URL with a host; no webhook is sent")
        return False
    # One id for every attempt of this delivery.
    deliver_webhook.delay(event, asset_id, version_id, str(uuid.uuid4()))
    return True


def sign(secret: str, body: bytes) -> str:
    """The X-FreeFrame-Signature value for a raw request body."""
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def _folder_chain(db, folder_id: Optional[uuid.UUID]) -> list[Folder]:
    """Live folders from the outermost down to `folder_id`.

    Stops at a deleted folder, so a deleted one is left out and so is everything
    above it, and on a parent cycle.
    """
    chain: list[Folder] = []
    seen: set[uuid.UUID] = set()
    while folder_id is not None and folder_id not in seen and len(seen) < MAX_DEPTH_WALK:
        seen.add(folder_id)
        folder = db.get(Folder, folder_id)
        if folder is None or folder.deleted_at is not None:
            break
        chain.append(folder)
        folder_id = folder.parent_id
    chain.reverse()
    return chain


def build_payload(db, event: str, asset_id: str, version_id: str) -> Optional[dict]:
    """The body for a delivery, or None when there is nothing live to report
    (the version, its asset or its project has been deleted since)."""
    version = db.get(AssetVersion, uuid.UUID(version_id))
    asset = db.get(Asset, uuid.UUID(asset_id))
    if version is None or version.deleted_at is not None:
        return None
    if asset is None or asset.deleted_at is not None or version.asset_id != asset.id:
        return None
    project = db.get(Project, asset.project_id)
    if project is None or project.deleted_at is not None:
        return None

    # An asset under a trashed folder counts as trashed, as it does for a share
    # link. The folder_id guard keeps the project root from being silenced.
    if asset.folder_id and not folder_chain_is_live(db, asset.folder_id):
        return None

    # null at the project root.
    chain = _folder_chain(db, asset.folder_id)
    folder = None
    if chain:
        folder = {
            "id": str(chain[-1].id),
            "name": chain[-1].name,
            "path": [f.name for f in chain],
        }

    return {
        "event": event,
        "delivered_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "project": {"id": str(project.id), "name": project.name},
        "folder": folder,
        "asset": {"id": str(asset.id), "name": asset.name},
        "version": {
            "id": str(version.id),
            "number": version.version_number,
            "status": WEBHOOK_EVENT_NAMES[event],
        },
    }


# ignore_result: nothing reads the outcome, and without it `.delay()` first
# subscribes to the Redis result backend, which can hold the transcode worker.
@shared_task(
    bind=True,
    name="apps.api.tasks.webhook_tasks.deliver_webhook",
    max_retries=MAX_RETRIES,
    ignore_result=True,
    soft_time_limit=SOFT_TIME_LIMIT,
    time_limit=HARD_TIME_LIMIT,
)
def deliver_webhook(self, event: str, asset_id: str, version_id: str, delivery_id: str):
    url = settings.webhook_url.strip()
    if not url or event not in WEBHOOK_EVENT_NAMES:
        return

    db = SessionLocal()
    try:
        payload = build_payload(db, event, asset_id, version_id)
    except (SQLAlchemyError, SoftTimeLimitExceeded) as exc:
        # A database that is restarting or locked comes back; the delivery should too.
        return _retry_or_give_up(self, event, delivery_id, version_id, exc)
    finally:
        db.close()
    if payload is None:
        log.info("Webhook %s for version %s skipped: nothing live to report", event, version_id)
        return

    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "FreeFrame-Webhook",
        "X-FreeFrame-Event": event,
        "X-FreeFrame-Delivery": delivery_id,
    }
    if settings.webhook_secret:
        headers["X-FreeFrame-Signature"] = sign(settings.webhook_secret, body)

    try:
        # No redirects: the receiver is the configured URL and nothing else.
        response = httpx.post(
            url, content=body, headers=headers, timeout=REQUEST_TIMEOUT, follow_redirects=False,
        )
    except httpx.HTTPError as exc:
        return _retry_or_give_up(self, event, delivery_id, version_id, exc)
    except (httpx.InvalidURL, UnicodeError) as exc:
        # A URL that passed the enqueue check but cannot be built; asking again will not help.
        log.error("Webhook %s (delivery %s) dropped: WEBHOOK_URL is unusable: %s", event, delivery_id, exc)
        return
    except SoftTimeLimitExceeded:
        return _retry_or_give_up(
            self, event, delivery_id, version_id, f"no answer within {SOFT_TIME_LIMIT}s",
        )

    if response.is_success:
        return
    if response.status_code < 500 and response.status_code not in RETRYABLE_CLIENT_ERRORS:
        log.error(
            "Webhook %s (delivery %s) refused with HTTP %s; not retrying",
            event, delivery_id, response.status_code,
        )
        return
    return _retry_or_give_up(self, event, delivery_id, version_id, f"HTTP {response.status_code}")


def _retry_or_give_up(task, event: str, delivery_id: str, version_id: str, reason) -> None:
    attempt = task.request.retries
    if attempt >= task.max_retries:
        log.error(
            "Webhook %s (delivery %s, version %s) given up after %d attempts: %s",
            event, delivery_id, version_id, attempt + 1, reason,
        )
        return
    countdown = RETRY_BASE_SECONDS * 2 ** attempt
    log.warning("Webhook %s (delivery %s) failed: %s; retrying in %ds", event, delivery_id, reason, countdown)
    raise task.retry(countdown=countdown)
