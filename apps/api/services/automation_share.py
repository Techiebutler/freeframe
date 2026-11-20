"""A standing share link for an automation, created with the project and announced once.

Aditor's Auto Review has no FreeFrame account. That is deliberate - it comments as a guest using
only a share token, which is why it needs no login, no password and no admin invite. The cost is
that it can only see a project somebody has explicitly shared with it, so every project needed a
link created by hand and pasted somewhere. One folder got one; the rest were invisible - not
broken, just unwatched, which is the harder failure to notice.

So: when a project is created, create ONE standing link for the automation and POST it to a
configured URL. The automation learns about the project the moment it exists, and nobody clicks
anything.

Both halves are off by default. No webhook URL configured means none of this runs, and an
instance that does not use an automation behaves exactly as it does now.

Failure here must never fail the project. A share link the automation never hears about is a
project it does not watch; a project that could not be created is an editor who cannot work.
"""

import logging
import secrets
from typing import Optional

import httpx
from sqlalchemy.orm import Session

from ..config import settings
from ..models.share import ShareLink, SharePermission, new_share_token

logger = logging.getLogger(__name__)


def is_enabled() -> bool:
    return bool((getattr(settings, "automation_share_webhook_url", "") or "").strip())


def create_standing_link(db: Session, project_id, created_by) -> Optional[ShareLink]:
    """A project-scoped link with the two switches the automation actually needs.

    `comment` and `allow_download` are not decoration: without commenting it cannot post the
    review, and without downloads only the streaming copy exists, which cannot be analysed. Those
    are the two conditions that have silently blocked real reviews, so they are set here rather
    than left to whoever creates the project.

    No expiry. A standing link that quietly dies takes the project's reviews with it, and that has
    already happened once with a link that had been shared by hand.
    """
    if not is_enabled():
        return None
    link = ShareLink(
        project_id=project_id,
        token=new_share_token(),
        created_by=created_by,
        title="Auto Review",
        description="Standing link so Auto Review can see this project. Safe to leave in place.",
        permission=SharePermission.comment,
        allow_download=True,
        visibility="public",
    )
    db.add(link)
    db.flush()
    return link


def create_standing_folder_link(db: Session, project_id, folder_id, created_by, *, bound_review: bool = False) -> Optional[ShareLink]:
    """The same standing link, scoped to ONE FOLDER.

    Aditor files each hand-in as a folder inside a per-brand project. The automation needs a link
    that shows exactly that hand-in and nothing else - a project-wide link would hand it every
    other card's cuts for the same brand, and it would review them all again on every folder.

    Same two switches as the project version, for the same reasons: without `comment` it cannot
    post the review, and without downloads only the streaming copy exists, which cannot be read.
    """
    # Selected new assignments register through the authenticated durable outbox.
    if not bound_review and not is_enabled():
        return None
    link = ShareLink(
        folder_id=folder_id,
        token=new_share_token(),
        created_by=created_by,
        title="Auto Review",
        description="Standing link so Auto Review can see this hand-in. Safe to leave in place.",
        permission=SharePermission.comment,
        allow_download=True,
        visibility="public",
    )
    db.add(link)
    db.flush()
    return link


def announce_folder(folder, link: ShareLink) -> None:
    """Tell the automation a hand-in exists, the same way a project announces itself.

    Deliberately the SAME endpoint and the same field names. The automation keys everything on a
    share token and does not care whether the token shows a project or a folder, so a folder
    arrives as a project-shaped registration with the folder's name and description - and needs no
    change on the far side at all.
    """
    url = (getattr(settings, "automation_share_webhook_url", "") or "").strip()
    if not url or link is None:
        return
    secret = (getattr(settings, "automation_share_webhook_secret", "") or "").strip()
    base = (getattr(settings, "frontend_url", "") or "").rstrip("/")
    try:
        httpx.post(
            url,
            json={
                "project_id": str(folder.project_id),
                "folder_id": str(folder.id),
                "project_name": folder.name,
                # The card link lives on the FOLDER now: it is the hand-in, so it is what carries
                # the brand, the briefing and the editor's name.
                "description": folder.description or "",
                "share_token": link.token,
                "share_url": f"{base}/share/{link.token}" if base else None,
            },
            headers={"authorization": f"Bearer {secret}"} if secret else {},
            timeout=10,
        )
    except Exception:  # noqa: BLE001 - a webhook must never fail a folder creation
        logger.warning("automation share webhook failed for folder %s", folder.id, exc_info=True)


def _folder_standing_link(db: Session, folder_id) -> Optional[ShareLink]:
    """The automation's own link for this folder, if one was ever created."""
    return (
        db.query(ShareLink)
        .filter(
            ShareLink.folder_id == folder_id,
            ShareLink.title == "Auto Review",
            ShareLink.is_enabled.is_(True),
            ShareLink.deleted_at.is_(None),
        )
        .order_by(ShareLink.created_at.desc())
        .first()
    )


def _standing_link(db: Session, project_id) -> Optional[ShareLink]:
    """The automation's own link for this project, if one was ever created."""
    return (
        db.query(ShareLink)
        .filter(
            ShareLink.project_id == project_id,
            ShareLink.title == "Auto Review",
            ShareLink.is_enabled.is_(True),
            ShareLink.deleted_at.is_(None),
        )
        .order_by(ShareLink.created_at.desc())
        .first()
    )


def announce_asset_ready(db: Session, asset, version_id) -> None:
    """Tell the automation a file has finished processing and can be read NOW.

    Without this the automation polls every ten minutes, so half of every wait is spent on a file
    that was ready the whole time. The review is the thing an editor is waiting for; five minutes
    of average delay is the difference between a tool that answers and a tool you go and check on
    later.

    Fires only when the project already has a standing automation link - i.e. only for instances
    that opted in by configuring the webhook. Best effort, never raises: a missed call costs the
    ten-minute poll, which is exactly where we were before.
    """
    if getattr(asset, "iteration_pending", False) is True or getattr(asset, "iteration_source", False) is True or getattr(asset,"iteration_derived",False) is True:
        return
    url = (getattr(settings, "automation_share_webhook_url", "") or "").strip()
    if not url:
        return
    # THE FOLDER'S LINK FIRST. An asset inside a hand-in folder belongs to that hand-in, and
    # telling the automation about the project-wide link instead would point it at every other
    # card for the same brand.
    link = None
    if getattr(asset, "folder_id", None):
        link = _folder_standing_link(db, asset.folder_id)
    if link is None:
        link = _standing_link(db, asset.project_id)
    if link is None:
        return
    secret = (getattr(settings, "automation_share_webhook_secret", "") or "").strip()
    try:
        httpx.post(
            url.replace("/project-registered", "/asset-ready"),
            json={
                "project_id": str(asset.project_id),
                "asset_id": str(asset.id),
                "version_id": str(version_id),
                "asset_name": asset.name,
                "share_token": link.token,
            },
            headers={"authorization": f"Bearer {secret}"} if secret else {},
            timeout=10,
        )
    except Exception:  # noqa: BLE001 - a webhook must never fail a transcode
        logger.warning("asset-ready webhook failed for asset %s", asset.id, exc_info=True)


def announce(project, link: ShareLink) -> None:
    """Tell the automation the project exists. Best effort, never raises."""
    url = (getattr(settings, "automation_share_webhook_url", "") or "").strip()
    if not url or link is None:
        return
    secret = (getattr(settings, "automation_share_webhook_secret", "") or "").strip()
    base = (getattr(settings, "frontend_url", "") or "").rstrip("/")
    try:
        httpx.post(
            url,
            json={
                "project_id": str(project.id),
                "project_name": project.name,
                # The description carries the brief link, which is how the automation works out
                # which brand and which card this project belongs to.
                "description": project.description or "",
                "share_token": link.token,
                "share_url": f"{base}/share/{link.token}" if base else None,
            },
            headers={"authorization": f"Bearer {secret}"} if secret else {},
            timeout=10,
        )
    except Exception:  # noqa: BLE001 - a webhook must never fail a project creation
        logger.warning("automation share webhook failed for project %s", project.id, exc_info=True)
