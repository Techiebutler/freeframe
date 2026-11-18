from pydantic import BaseModel, Field
import uuid
from datetime import datetime
from typing import Optional
from ..models.approval import ApprovalStatus

class ApprovalCreate(BaseModel):
    version_id: uuid.UUID
    # Same limit as a verdict note: one column, one notification, one email.
    note: Optional[str] = Field(default=None, max_length=5000)

class ApprovalResponse(BaseModel):
    id: uuid.UUID
    asset_id: uuid.UUID
    version_id: uuid.UUID
    # None for a share-link guest's verdict, which has a guest_user_id instead.
    user_id: Optional[uuid.UUID]
    status: ApprovalStatus
    note: Optional[str]
    created_at: datetime
    model_config = {"from_attributes": True}
