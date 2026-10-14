"""clear branding logo values that do not point at an uploaded logo

`project_brandings.logo_s3_key` and the five `instance_branding` logo columns
hold storage keys. Responses sign them (the instance ones on an unauthenticated
GET) and replacing or purging deletes them. The only keys the upload steps issue
are `branding/<project id>/logo/<name>` for a project and
`branding/<slot>/<name>` for each instance slot, and those are now the only
values the API accepts, signs or deletes (see `services/owned_keys.py`). Clear
anything else, so a stored value that names some other object stops referring
to it. The rule mirrors `is_owned_key` exactly: the issued prefix, followed by
one non-empty path segment that is not `.` or `..`.

Revision ID: d2b7e5f9a1c3
Revises: c4f1e8a2d6b9
Create Date: 2026-10-14
"""
from typing import Sequence, Union
from alembic import op

revision: str = 'd2b7e5f9a1c3'
down_revision: Union[str, Sequence[str], None] = 'c4f1e8a2d6b9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# column -> the upload slot whose prefix it accepts (routers/instance_branding.py)
_INSTANCE_SLOTS = {
    "logo_light_key": "logo-light",
    "logo_dark_key": "logo-dark",
    "favicon_key": "favicon",
    "apple_icon_key": "apple-icon",
    "login_logo_key": "login-logo",
}


def _not_owned(column: str, prefix_sql: str) -> str:
    """SQL true when `column` is set and is not `prefix` + one plain segment."""
    rest = f"substr({column}, length({prefix_sql}) + 1)"
    return rf"""
        {column} IS NOT NULL
        AND NOT (
                left({column}, length({prefix_sql})) = {prefix_sql}
            AND {rest} NOT IN ('', '.', '..')
            AND strpos({rest}, '/') = 0
            AND strpos({rest}, E'\\') = 0
        )
    """


def upgrade() -> None:
    op.execute(
        "UPDATE project_brandings SET logo_s3_key = NULL WHERE "
        + _not_owned("logo_s3_key", "('branding/' || project_id::text || '/logo/')")
    )
    for column, slot in _INSTANCE_SLOTS.items():
        op.execute(
            f"UPDATE instance_branding SET {column} = NULL WHERE "
            + _not_owned(column, f"'branding/{slot}/'")
        )


def downgrade() -> None:
    # Cleared values are not restored: they were never valid logos.
    pass
