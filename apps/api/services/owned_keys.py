"""Which storage keys a column may name, by the prefix the server issued them under.

Several columns hold an object key that the client hands back after uploading
to a presigned URL: a user's avatar, a project's logo, the instance logos.
Responses sign those keys into download links and replacing or purging the row
deletes them, so a column is only trusted when it names an object the server
itself issued for that slot:

    <issued prefix><one path segment>

Anything else, including a full URL, a key under another prefix, a key with
extra path segments, or a `.`/`..` segment, is treated as nothing: it is never
accepted, signed or deleted. `services/avatar_keys.py` applies this to avatars;
the branding helpers below apply it to logos.

The matching SQL in the alembic migrations that clear non-conforming values
mirrors `is_owned_key` exactly; change both together.
"""
import uuid
from typing import Optional


def is_owned_key(prefix: str, key: Optional[str]) -> bool:
    """True only for `prefix` followed by one non-empty segment other than `.`/`..`."""
    if not prefix or not isinstance(key, str) or not key:
        return False
    if not key.startswith(prefix):
        return False
    name = key[len(prefix):]
    return name not in ("", ".", "..") and "/" not in name and "\\" not in name


# ── Project branding ─────────────────────────────────────────────────────────
# Issued by POST /projects/{project_id}/branding/logo-upload.

def project_logo_prefix(project_id: uuid.UUID | str) -> str:
    return f"branding/{project_id}/logo/"


def is_project_logo_key(project_id: uuid.UUID | str | None, key: Optional[str]) -> bool:
    if not project_id:
        return False
    return is_owned_key(project_logo_prefix(project_id), key)


# ── Instance branding ────────────────────────────────────────────────────────
# Issued by POST /instance/branding/{logo_type}-upload as branding/{logo_type}/<uuid>.
# Each column accepts only its own slot's prefix.

INSTANCE_LOGO_SLOTS = {
    "logo-light": "logo_light_key",
    "logo-dark": "logo_dark_key",
    "favicon": "favicon_key",
    "apple-icon": "apple_icon_key",
    "login-logo": "login_logo_key",
}
INSTANCE_LOGO_COLUMNS = {column: slot for slot, column in INSTANCE_LOGO_SLOTS.items()}


def instance_logo_prefix(logo_type: str) -> str:
    return f"branding/{logo_type}/"


def is_instance_logo_key(column: str, key: Optional[str]) -> bool:
    slot = INSTANCE_LOGO_COLUMNS.get(column)
    if slot is None:
        return False
    return is_owned_key(instance_logo_prefix(slot), key)


def sign_if_owned(owned: bool, key: Optional[str]) -> Optional[str]:
    """A download link for `key` when `owned`, else None. Signing errors read as None."""
    if not owned:
        return None
    from . import s3_service
    try:
        return s3_service.generate_presigned_get_url(key)
    except Exception:
        return None
