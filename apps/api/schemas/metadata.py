from datetime import datetime
from pydantic import BaseModel, Field
import uuid
from typing import Any, Literal, Optional

from ..models.share import SharePermission


class MetadataFieldCreate(BaseModel):
    name: str = Field(max_length=255)
    field_type: Literal["text", "number", "date", "select", "multi_select", "url", "boolean"]
    options: Optional[list[str]] = None  # for select/multi_select
    required: bool = False


class MetadataFieldResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    field_type: Literal["text", "number", "date", "select", "multi_select", "url", "boolean"]
    options: Optional[list[str]] = None
    required: bool
    model_config = {"from_attributes": True}


class AssetMetadataSet(BaseModel):
    field_id: uuid.UUID
    value: Optional[Any] = None


class AssetMetadataResponse(BaseModel):
    field_id: uuid.UUID
    field_name: str
    field_type: str
    value: Optional[Any] = None


class CollectionCreate(BaseModel):
    name: str = Field(max_length=255)
    filter_rules: Optional[dict] = None


class CollectionResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    filter_rules: Optional[dict] = None
    is_smart: bool
    asset_count: int = 0
    model_config = {"from_attributes": True}


class CollectionShareCreate(BaseModel):
    permission: SharePermission = SharePermission.view
    expires_at: Optional[datetime] = None


class CollectionShareResponse(BaseModel):
    id: uuid.UUID
    token: str
    permission: SharePermission
    expires_at: Optional[datetime] = None
    model_config = {"from_attributes": True}
