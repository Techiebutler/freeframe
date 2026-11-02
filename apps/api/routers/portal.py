"""Server-to-server delivery-folder endpoint for the Aditor portal.

Part 1 of roadmap step 5 (portal dispatch-v2): the portal wants to orchestrate a hand-in without a
human behind a browser, so it needs a credential that can WRITE a folder, its editor upload link
and its client review link. The only existing machine credential - X-API-Key
(middleware/auth.py `_service_key_user`) - is deliberately read-only, so this adds exactly one
scoped write path rather than widening it.

Trust is inbound HMAC-SHA256 over the raw request body on X-Aditor-Signature: the same scheme and
header FreeFrame already uses as the SENDER of the hub/portal webhooks (services/hub_events.py
`_deliver`), just verified here instead of produced.
"""
import hashlib
import hmac
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ValidationError
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models.folder import Folder
from ..models.project import Project
from ..models.user import UserStatus
from ..services.auth_service import get_user_by_email
from ..services.checklists import dispatch_binding, reserve_binding
from .requests import CARD_URL, ensure_folder_assignment

router = APIRouter(tags=["portal-integration"])


class PortalDeliveryFolderBody(BaseModel):
    card_url: str
    workspace_project_id: uuid.UUID
    title: Optional[str] = None


def _verify_signature(raw_body: bytes, presented: Optional[str]) -> None:
    secret = (settings.portal_freeframe_hmac_secret or "").strip()
    # Unset secret fails CLOSED - an unconfigured instance refuses the endpoint, it never treats a
    # missing secret as "anything goes".
    if not secret:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Portal integration is not configured")
    if not presented:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing signature")
    expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(presented, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid signature")


def _service_user(db: Session):
    """The staff account every portal-created folder, share and request is attributed to - never a
    human user, and never guessed when the instance has not configured one."""
    email = (settings.portal_freeframe_service_email or "").strip()
    user = get_user_by_email(db, email) if email else None
    if not user or user.status == UserStatus.deactivated:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Portal service account is unavailable")
    return user


def review_binding(db: Session, req, folder: Folder, binding, actor_id):
    """The binding that registers this hand-in with Auto Review, reserved when the folder has none.

    Every other way a hand-in comes to exist reserves one (create_request, the staff hand-in page), and
    only a binding ever calls register_request (tasks/checklist_tasks.py). A portal hand-in without one
    was never heard of by Auto Review: the editor page said "Review unavailable" for good and finish
    stayed blocked. Keyed on the request, so a repeated call or a later repair finds the same row.
    """
    if binding is not None:
        # A binding with no share token is skipped by registration (_register) just the same.
        if not binding.review_share_token:
            binding.review_share_token = req.review_share_token
        return binding
    intent = {"brand": req.brand_slug, "title": req.title, "brief_text": "",
              "brief_url": (folder.description or "").strip(), "brief_pdf_base64": ""}
    binding = reserve_binding(db, req.project_id, actor_id, f"portal:{req.id}", intent)
    binding.request_id = req.id
    binding.folder_id = folder.id
    binding.review_share_token = req.review_share_token
    return binding


@router.post("/integrations/portal/delivery-folder")
async def portal_delivery_folder(request: Request, db: Session = Depends(get_db)):
    raw_body = await request.body()
    _verify_signature(raw_body, request.headers.get("x-aditor-signature"))
    try:
        body = PortalDeliveryFolderBody.model_validate_json(raw_body)
    except ValidationError as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(error)) from error

    card_url = body.card_url.strip()
    match = CARD_URL.fullmatch(card_url)
    if not match:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "card_url must be an exact Trello card link")
    card_key = match[1]

    project = (
        db.query(Project)
        .filter(Project.id == body.workspace_project_id, Project.deleted_at.is_(None))
        .populate_existing()
        .with_for_update()
        .first()
    )
    if not project or not project.is_workspace:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")

    service_user = _service_user(db)

    # Reuse the exact folder a prior call (or the interactive hand-in page) already made for this
    # card, rather than filing a second one - this is the dedup frontend/app/(dashboard)/handin
    # page.tsx otherwise does client-side, moved server-side so the portal can rely on it too.
    folder = (
        db.query(Folder)
        .filter(Folder.project_id == project.id, Folder.deleted_at.is_(None), Folder.description.ilike(f"%/c/{card_key}%"))
        .order_by(Folder.created_at)
        .first()
    )
    if folder is None:
        folder = Folder(project_id=project.id, name=(body.title or "").strip() or card_key,
                        description=card_url, created_by=service_user.id)
        db.add(folder)
        db.flush()

    # The brand attestation (confirmed_brand mismatch -> 409) happens inside ensure_folder_assignment,
    # against folder.description - identical to card_url for both a brand-new and a reused folder.
    req, binding = ensure_folder_assignment(db, folder, project, service_user.id, create_share_if_missing=True)
    binding = review_binding(db, req, folder, binding, service_user.id)
    db.commit()
    # After the commit, and fail-open like create_request: the links work even while Auto Review is down,
    # and the binding's own retries (resume_checklists) finish the registration.
    dispatch_binding(binding.id)

    base = (settings.frontend_url or "").rstrip("/")
    return {
        "folder_id": str(folder.id),
        "upload_url": f"{base}/r/{req.token}",
        "review_url": f"{base}/share/{req.review_share_token}",
        "token": req.token,
        "review_share_token": req.review_share_token,
    }
