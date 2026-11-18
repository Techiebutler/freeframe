from pydantic import BaseModel
import uuid
from datetime import datetime
from typing import Optional
from ..models.approval import ApprovalStatus

class ApprovalCreate(BaseModel):
    version_id: uuid.UUID
    note: Optional[str] = None

class ApprovalResponse(BaseModel):
    id: uuid.UUID
    asset_id: uuid.UUID
    version_id: uuid.UUID
    user_id: uuid.UUID
    status: ApprovalStatus
    note: Optional[str]
    created_at: datetime
    delivery: Optional[dict] = None  # approve only: {token, share_url} of the hand-off page
    parts: Optional[dict] = None  # approve only: {approved, total, complete} of the request's parts
    model_config = {"from_attributes": True}
