from pydantic import BaseModel
import uuid
from datetime import datetime
from typing import Optional, Literal
from ..models.share import SharePermission


class ShareLinkAppearance(BaseModel):
    layout: Literal["grid", "list"] = "grid"
    theme: Literal["dark", "light"] = "dark"
    accent_color: Optional[str] = None
    open_in_viewer: bool = True
    sort_by: Literal["name", "created_at", "file_size"] = "created_at"


class ShareLinkCreate(BaseModel):
    permission: SharePermission = SharePermission.view
    expires_at: Optional[datetime] = None
    password: Optional[str] = None
    allow_download: bool = False
    title: Optional[str] = None
    description: Optional[str] = None
    show_versions: bool = True
    show_watermark: bool = False
    appearance: ShareLinkAppearance = ShareLinkAppearance()


class ShareLinkResponse(BaseModel):
    id: uuid.UUID
    asset_id: Optional[uuid.UUID] = None
    folder_id: Optional[uuid.UUID] = None
    token: str
    title: str
    description: Optional[str] = None
    is_enabled: bool
    permission: SharePermission
    allow_download: bool
    show_versions: bool
    show_watermark: bool
    appearance: dict
    expires_at: Optional[datetime] = None
    created_at: datetime
    model_config = {"from_attributes": True}


class ShareLinkValidateResponse(BaseModel):
    asset_id: Optional[uuid.UUID] = None
    folder_id: Optional[uuid.UUID] = None
    folder_name: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    permission: SharePermission
    allow_download: bool
    show_versions: bool = True
    show_watermark: bool = False
    appearance: Optional[dict] = None
    requires_password: bool


class ShareLinkUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    permission: Optional[SharePermission] = None
    is_enabled: Optional[bool] = None
    show_versions: Optional[bool] = None
    show_watermark: Optional[bool] = None
    appearance: Optional[ShareLinkAppearance] = None
    password: Optional[str] = None
    expires_at: Optional[datetime] = None
    allow_download: Optional[bool] = None


class ShareLinkListItem(BaseModel):
    id: uuid.UUID
    token: str
    title: str
    description: Optional[str] = None
    is_enabled: bool
    permission: SharePermission
    share_type: str
    target_name: str
    view_count: int = 0
    last_viewed_at: Optional[datetime] = None
    model_config = {"from_attributes": True}


class ShareLinkActivityResponse(BaseModel):
    id: uuid.UUID
    share_link_id: uuid.UUID
    action: str
    actor_email: str
    actor_name: Optional[str] = None
    asset_id: Optional[uuid.UUID] = None
    asset_name: Optional[str] = None
    created_at: datetime
    model_config = {"from_attributes": True}


class FolderShareAssetItem(BaseModel):
    id: uuid.UUID
    name: str
    asset_type: str
    thumbnail_url: Optional[str] = None
    file_size: Optional[int] = None
    created_at: datetime


class FolderShareSubfolder(BaseModel):
    id: uuid.UUID
    name: str
    item_count: int = 0


class FolderShareAssetsResponse(BaseModel):
    assets: list[FolderShareAssetItem]
    subfolders: list[FolderShareSubfolder]
    total: int
    page: int
    per_page: int


class DirectShareCreate(BaseModel):
    permission: SharePermission = SharePermission.view
    user_id: Optional[uuid.UUID] = None
    team_id: Optional[uuid.UUID] = None


class DirectShareResponse(BaseModel):
    id: uuid.UUID
    asset_id: Optional[uuid.UUID] = None
    folder_id: Optional[uuid.UUID] = None
    shared_with_user_id: Optional[uuid.UUID]
    shared_with_team_id: Optional[uuid.UUID]
    permission: SharePermission
    created_at: datetime
    model_config = {"from_attributes": True}
