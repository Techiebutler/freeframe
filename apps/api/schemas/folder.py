import uuid
from datetime import datetime
from typing import Annotated, Optional
from pydantic import BaseModel, Field, field_validator

from ..services.folder_paths import (
    MAX_ENSURE_PATHS,
    MAX_FOLDER_DEPTH,
    folder_name_problem,
    normalize_folder_name,
)


class FolderCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    parent_id: Optional[uuid.UUID] = None


class FolderUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    parent_id: Optional[uuid.UUID] = None  # use model_fields_set to distinguish unset vs null


class FolderResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    parent_id: Optional[uuid.UUID]
    name: str
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime
    item_count: int = 0

    model_config = {"from_attributes": True}


class FolderTreeNode(BaseModel):
    id: uuid.UUID
    name: str
    parent_id: Optional[uuid.UUID]
    item_count: int = 0
    children: list["FolderTreeNode"] = []


class AssetMoveRequest(BaseModel):
    folder_id: Optional[uuid.UUID] = None  # null = move to root


class BulkMoveRequest(BaseModel):
    asset_ids: list[uuid.UUID] = []
    folder_ids: list[uuid.UUID] = []
    target_folder_id: Optional[uuid.UUID] = None  # null = root


class EnsureFoldersRequest(BaseModel):
    """The folder paths an upload needs, relative to `parent_id` (None: the
    project root). ["Card", "DCIM"] is Card, then DCIM inside it."""

    parent_id: Optional[uuid.UUID] = None
    paths: list[
        Annotated[list[str], Field(min_length=1, max_length=MAX_FOLDER_DEPTH)]
    ] = Field(..., min_length=1, max_length=MAX_ENSURE_PATHS)

    @field_validator("paths")
    @classmethod
    def _valid_names(cls, paths: list[list[str]]) -> list[list[str]]:
        # Checked on the normalised name, which is what gets stored. The paths
        # themselves are kept as sent, so the response echoes them unchanged.
        for path in paths:
            for segment in path:
                problem = folder_name_problem(normalize_folder_name(segment))
                if problem:
                    raise ValueError(problem)
        return paths

    def normalized_paths(self) -> list[tuple[str, ...]]:
        return [tuple(normalize_folder_name(s) for s in path) for path in self.paths]


class EnsuredFolder(BaseModel):
    # The path exactly as the request sent it.
    path: list[str]
    # The folder the path ends in, after any cut at the depth limit. None is
    # the parent itself (the project root when parent_id was None).
    folder_id: Optional[uuid.UUID]


class EnsureFoldersResponse(BaseModel):
    # One entry per requested path, in request order.
    folders: list[EnsuredFolder]
