from pydantic import AfterValidator, BaseModel, EmailStr, field_validator, Field
from typing import Annotated
import uuid
from ..models.user import UserStatus
from ..services.auth_service import BCRYPT_MAX_PASSWORD_BYTES


def _reject_bcrypt_overflow(v: str) -> str:
    """Reject passwords bcrypt would silently truncate.

    The limit is 72 *bytes*, but Field(max_length=...) counts characters, so a
    72-character password of multi-byte characters still overflows: bcrypt
    hashes only its first 72 bytes and any two passwords sharing that prefix
    verify against the same hash. Measure the encoded length instead.
    """
    if len(v.encode("utf-8")) > BCRYPT_MAX_PASSWORD_BYTES:
        raise ValueError(
            f"password must be at most {BCRYPT_MAX_PASSWORD_BYTES} bytes when UTF-8 encoded"
        )
    return v


# Password constraints for anything that *sets* a password. The 8-char floor
# closes the empty/1-char password hole that let accounts be created with
# trivially-guessable credentials; the byte ceiling stops a new password from
# ever being stored truncated.
NewPassword = Annotated[str, Field(min_length=8), AfterValidator(_reject_bcrypt_overflow)]

class LoginRequest(BaseModel):
    email: EmailStr
    # No length bounds on login. A creation-side floor prevents new weak
    # passwords, but enforcing bounds here would lock out existing accounts
    # (422 instead of 401) — both ones set before the floor existed and ones
    # longer than the bcrypt ceiling, which still authenticate correctly
    # because verification truncates to the same 72 bytes the hash was made
    # from. The cap below is only a sanity bound so an oversized body never
    # reaches the hashing path.
    password: str = Field(max_length=4096)

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
    password: NewPassword

# Invite flow
class AcceptInviteRequest(BaseModel):
    token: str
    password: NewPassword

class InviteInfoResponse(BaseModel):
    email: str
    name: str
    org_name: str | None = None

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: NewPassword

class UpdateProfileRequest(BaseModel):
    name: str | None = None
    avatar_url: str | None = None

class UpdateUserRoleRequest(BaseModel):
    is_admin: bool

class DeactivateUserRequest(BaseModel):
    user_id: uuid.UUID


# Notification preferences are a flat map of short strings — the settings UI
# writes one choice per channel (e.g. {"mentions": "all_on"}). Bounding the key
# count and the key/value lengths is what actually makes "primitive values
# only" true: a bare `dict` accepted arbitrarily deep and arbitrarily large
# JSON, which is the stored-value surface this schema exists to close.
_PreferenceString = Annotated[str, Field(max_length=64)]
NotificationPreferences = Annotated[
    dict[_PreferenceString, _PreferenceString], Field(max_length=50)
]


class PreferencesUpdate(BaseModel):
    """Schema-constrained preferences update.

    Replaces the previous `body: dict` signature on PATCH /auth/me/preferences
    so users can't store arbitrary giant/nested values (which would also be a
    stored-XSS surface if any preference is rendered back without escaping).
    Known keys only, primitive values only.
    """
    # Reject unknown keys instead of dropping them. Pydantic's default is to
    # ignore extras, which would answer 200 OK for a preference this schema
    # doesn't model while silently discarding the write.
    model_config = {"extra": "forbid"}

    theme: _PreferenceString | None = None
    notifications: NotificationPreferences | None = None

