"""The one rule for which storage keys a user's avatar may name.

`User.avatar_url` holds an object key, not a URL. Every response that shows a
user signs it into a download link, and replacing an avatar deletes the
previous key. Both of those act on whatever the column holds, so the column is
only trusted when it names an object under that user's own avatar prefix, the
only place the avatar upload step ever writes to:

    avatars/<user id>/<one path segment>

Anything else, including a full URL, a key under another prefix, another
user's avatar, or a key with extra or dot path segments, is treated as no
avatar: it is never signed and never deleted. The segment rule itself is
`owned_keys.is_owned_key`, shared with the branding logo columns.
"""
import uuid
from typing import Optional

from .owned_keys import is_owned_key


def avatar_prefix(user_id: uuid.UUID | str) -> str:
    return f"avatars/{user_id}/"


def is_own_avatar_key(user_id: uuid.UUID | str | None, key: Optional[str]) -> bool:
    """True only for a key the avatar upload step could have issued to this user."""
    if not user_id:
        return False
    return is_owned_key(avatar_prefix(user_id), key)


def sign_avatar(user_id: uuid.UUID | str | None, key: Optional[str]) -> Optional[str]:
    """A download link for the user's own avatar, or None for anything else."""
    if not is_own_avatar_key(user_id, key):
        return None
    from . import s3_service
    return s3_service.generate_presigned_get_url(key)


def delete_own_avatar(user_id: uuid.UUID | str, key: Optional[str]) -> bool:
    """Delete a replaced avatar object, but only if it is this user's own.

    Returns whether a delete was issued. Storage errors are swallowed: a
    leftover avatar object is harmless and must not fail the request.
    """
    if not is_own_avatar_key(user_id, key):
        return False
    from . import s3_service
    try:
        s3_service.delete_object(key)
    except Exception:
        pass
    return True
