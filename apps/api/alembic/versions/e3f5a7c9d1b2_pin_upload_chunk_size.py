"""pin the multipart chunk size per upload

A resume has to place part N at exactly the byte range the parts already in the
bucket were cut on. That range is derived from the chunk size, which until now
lived only as a constant in the web bundle -- so an upload interrupted before a
release and resumed after one that changed the constant would write parts that
overlap or leave gaps, and R2 additionally requires every non-final part to be
the same size.

Recording it at initiate makes it a property of the upload rather than of
whatever build the browser happens to be running.

Revision ID: e3f5a7c9d1b2
Revises: cdcf8e5a6437
Create Date: 2026-09-03
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = 'e3f5a7c9d1b2'
down_revision: Union[str, Sequence[str], None] = 'cdcf8e5a6437'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable with no backfill. Backfilling today's constant would be a guess
    # about uploads started under an older one, and the resume path has a better
    # answer available for those rows: the size of a part the backend is already
    # holding is the size that upload was actually cut on.
    op.add_column(
        'asset_versions', sa.Column('chunk_size_bytes', sa.Integer(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column('asset_versions', 'chunk_size_bytes')
