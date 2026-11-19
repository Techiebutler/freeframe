"""Downloads open only after a human approval (the founder, 2026-11-19, spec 2026-11-19-download-after-approval).

The gate is a Delivery row: only the human approve path (`deliveries.on_approved`) creates one, and a request with
several parts gets none until every part is approved. Never AssetStatus: the iteration runner sets `approved` on its own.
Two callers pass without a delivery: the project owner (a draft, E1) and the review engine's service key, which must
read the original to review it at all."""
import uuid
from typing import Optional

from sqlalchemy.orm import Session

from ..config import settings
from ..models.delivery import Delivery
from ..models.project import ProjectRole
from ..models.user import User
from .permissions import effective_project_role

NOT_RELEASED = "not_released"  # the 403 detail the web shows as "available after approval"


def released(db: Session, version_id: uuid.UUID) -> bool:
    return db.query(Delivery.id).filter(Delivery.version_id == version_id).first() is not None


def is_engine(user: Optional[User]) -> bool:
    return bool(user and settings.service_api_key_email and user.email == settings.service_api_key_email)


def may_download(db: Session, project_id: uuid.UUID, version_id: uuid.UUID, user: Optional[User]) -> bool:
    if is_engine(user):
        return True
    if user is not None and effective_project_role(db, project_id, user) == ProjectRole.owner:
        return True
    return released(db, version_id)
