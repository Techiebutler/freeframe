"""widen file_size_bytes to bigint

Revision ID: 54b1ad156f8f
Revises: dfcdaa30f89e
Create Date: 2026-07-06 19:36:42.295309

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '54b1ad156f8f'
down_revision: Union[str, Sequence[str], None] = 'dfcdaa30f89e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Widen file_size_bytes from INTEGER (int4, ~2.1GB) to BIGINT so files larger
    than ~2.1GB can be recorded (media files support up to 10GB+).

    WARNING: int4->int8 is not binary-coercible in PostgreSQL, so each ALTER COLUMN
    rewrites the entire table under an ACCESS EXCLUSIVE lock, blocking all reads/writes
    to media_files (and comment_attachments) for the rewrite's duration. On a large
    deployment run this in a maintenance window, or migrate zero-downtime via a
    nullable new column + backfill + rename."""
    op.alter_column("media_files", "file_size_bytes",
                    existing_type=sa.Integer(), type_=sa.BigInteger(), existing_nullable=False)
    op.alter_column("comment_attachments", "file_size_bytes",
                    existing_type=sa.Integer(), type_=sa.BigInteger(), existing_nullable=False)


def downgrade() -> None:
    """Revert to INTEGER. NOTE: rows with file_size_bytes > 2^31-1 would overflow and
    fail this downgrade — acceptable, since such values could not have existed before."""
    op.alter_column("comment_attachments", "file_size_bytes",
                    existing_type=sa.BigInteger(), type_=sa.Integer(), existing_nullable=False)
    op.alter_column("media_files", "file_size_bytes",
                    existing_type=sa.BigInteger(), type_=sa.Integer(), existing_nullable=False)
