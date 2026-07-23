from pydantic import BaseModel, EmailStr, field_validator
import uuid
from ..models.user import UserStatus

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    needs_password: bool = False  # True if user needs to set password

class RefreshRequest(BaseModel):
    refresh_token: str

class UserResponse(BaseModel):
    id: uuid.UUID
    email: str
    name: str
    avatar_url: str | None
    status: UserStatus
    email_verified: bool = False
    is_superadmin: bool = False
    preferences: dict = {}

    model_config = {"from_attributes": True}

    @field_validator("avatar_url", mode="after")
    @classmethod
    def resolve_avatar_url(cls, v: str | None) -> str | None:
        if v and not v.startswith("http"):
            from ..services import s3_service
            return s3_service.generate_presigned_get_url(v)
        return v

class AdminUserResponse(UserResponse):
    """UserResponse plus the pending invite token.

    Only for admin-gated endpoints: exposing invite_token to any authenticated
    caller lets them hijack a pending invite before the invitee accepts it.
    """
    invite_token: str | None = None

class InviteRequest(BaseModel):
    email: EmailStr
    name: str

# Magic code flow
class SendMagicCodeRequest(BaseModel):
    email: EmailStr

class SendMagicCodeResponse(BaseModel):
    message: str
    email: str

class VerifyMagicCodeRequest(BaseModel):
    email: EmailStr
    code: str

class SetPasswordRequest(BaseModel):
    password: str

# Invite flow
class AcceptInviteRequest(BaseModel):
    token: str
    password: str

class InviteInfoResponse(BaseModel):
    email: str
    name: str
    org_name: str | None = None

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

class UpdateProfileRequest(BaseModel):
    name: str | None = None
    avatar_url: str | None = None

class UpdateUserRoleRequest(BaseModel):
    is_admin: bool

class DeactivateUserRequest(BaseModel):
    user_id: uuid.UUID

