from pydantic import BaseModel, field_validator
import uuid
from datetime import datetime
from ..models.project import ProjectType, ProjectRole

class ProjectCreate(BaseModel):
    name: str
    description: str | None = None
    project_type: ProjectType = ProjectType.personal
    # Projects are created only by admins / the onboarding automation now, and what they create is a
    # brand workspace, so this defaults true. The hand-in dropdown shows only workspaces.
    is_workspace: bool = True

class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    is_public: bool | None = None
    is_workspace: bool | None = None
    agents_may_approve: bool | None = None

class ProjectResponse(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    project_type: ProjectType
    created_by: uuid.UUID
    created_at: datetime
    poster_url: str | None = None
    is_public: bool = False
    is_workspace: bool = False
    agents_may_approve: bool = False
    asset_count: int = 0

    @field_validator("agents_may_approve", mode="before")
    @classmethod
    def _flag_only_when_a_real_bool(cls, v):
        return v if isinstance(v, bool) else False
    storage_bytes: int = 0
    member_count: int = 0
    role: ProjectRole | None = None
    model_config = {"from_attributes": True}

class ProjectMemberResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    user_id: uuid.UUID
    role: ProjectRole
    model_config = {"from_attributes": True}

class AddProjectMemberRequest(BaseModel):
    user_id: uuid.UUID
    role: ProjectRole = ProjectRole.viewer

class UpdateProjectMemberRequest(BaseModel):
    role: ProjectRole
