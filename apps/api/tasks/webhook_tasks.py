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

import httpx
from celery import shared_task

from ..config import settings
from ..database import SessionLocal
from ..models.asset import Asset, AssetVersion
from ..models.folder import Folder
from ..models.project import Project
from ..services.folder_paths import MAX_DEPTH_WALK

log = logging.getLogger("celery.webhook")

#: Events WEBHOOK_EVENTS can name, and the version status each reports.
WEBHOOK_EVENT_NAMES = {
    "transcode_complete": "ready",
    "transcode_failed": "failed",
}

#: Seconds the receiver gets to connect and to answer.
REQUEST_TIMEOUT = 10.0
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


def enqueue_webhook(event: str, asset_id: str, version_id: str) -> bool:
    """Queue a delivery if a webhook is configured for `event`. True if queued."""
    if not settings.webhook_url.strip() or event not in enabled_events():
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

    # null at the project root, and when the asset's own folder is deleted.
    chain = _folder_chain(db, asset.folder_id)
    folder = None
    if chain and chain[-1].id == asset.folder_id:
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


@shared_task(bind=True, name="apps.api.tasks.webhook_tasks.deliver_webhook", max_retries=MAX_RETRIES)
def deliver_webhook(self, event: str, asset_id: str, version_id: str, delivery_id: str):
    url = settings.webhook_url.strip()
    if not url or event not in WEBHOOK_EVENT_NAMES:
        return

    db = SessionLocal()
    try:
        payload = build_payload(db, event, asset_id, version_id)
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
