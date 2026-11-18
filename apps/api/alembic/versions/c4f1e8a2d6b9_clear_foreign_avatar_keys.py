"""clear avatar values that do not point at an uploaded avatar

`users.avatar_url` holds a storage key. The only key the avatar upload step
issues is `avatars/<user id>/<name>`, and that is now the only value the API
signs or deletes (see `services/avatar_keys.py`). Clear anything else, so a
stored value that names some other object stops referring to it. The rule here
mirrors `is_own_avatar_key` exactly: the user's own prefix, followed by one
non-empty path segment that is not `.` or `..`.

Revision ID: c4f1e8a2d6b9
Revises: a7d2c4e6f810
Create Date: 2026-10-14
"""
from typing import Sequence, Union
from alembic import op

revision: str = 'c4f1e8a2d6b9'
down_revision: Union[str, Sequence[str], None] = 'a7d2c4e6f810'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        r"""
        UPDATE users
        SET avatar_url = NULL
        WHERE avatar_url IS NOT NULL
          AND NOT (
                left(avatar_url, length('avatars/' || id::text || '/'))
                    = 'avatars/' || id::text || '/'
            AND substr(avatar_url, length('avatars/' || id::text || '/') + 1)
                    NOT IN ('', '.', '..')
            AND strpos(substr(avatar_url, length('avatars/' || id::text || '/') + 1), '/') = 0
            AND strpos(substr(avatar_url, length('avatars/' || id::text || '/') + 1), E'\\') = 0
          )
        """
    )


def downgrade() -> None:
    # Cleared values are not restored: they were never valid avatars.
    pass
