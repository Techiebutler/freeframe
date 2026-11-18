import uuid
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

# What may be sent. `pending` is a stored enum value no code path writes, so it is
# not a verdict and is refused with a 422 at the edge.
VerdictValue = Literal["approved", "changes_requested", "rejected"]


class VerdictSet(BaseModel):
    version_id: uuid.UUID
    status: VerdictValue
    note: Optional[str] = Field(default=None, max_length=5000)


class ShareVerdictSet(VerdictSet):
    # Folder and project links hold many assets, so the caller names the one.
    asset_id: Optional[uuid.UUID] = None
    # Only read for a caller who is not signed in.
    guest_name: Optional[str] = Field(default=None, max_length=255)
    guest_email: Optional[str] = Field(default=None, max_length=255)


class VerdictWho(BaseModel):
    """Who gave a verdict. Never carries an email: viewers and guests can read it."""
    # `team` is a live member of the asset's project, worked out when the verdict is
    # read. Everyone else, guests and signed-in non-members alike, is `external`.
    kind: Literal["team", "external"]
    name: str
    avatar_url: Optional[str] = None
    avatar_color: Optional[str] = None
    # A share-link guest with no account, as opposed to a signed-in non-member.
    is_guest: bool


class VerdictResponse(BaseModel):
    id: uuid.UUID
    version_id: uuid.UUID
    status: VerdictValue
    note: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    who: VerdictWho
    # The link's title when the verdict was given, kept after the link is gone.
    via_link_title: Optional[str] = None
    is_mine: bool


class VerdictSummary(BaseModel):
    approved: int = 0
    changes_requested: int = 0
    rejected: int = 0
