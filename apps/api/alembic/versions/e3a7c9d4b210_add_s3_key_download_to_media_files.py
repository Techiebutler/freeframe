"""add s3_key_download to media_files

The single-file MP4 a video transcode now remuxes from its top HLS rung, so a
download has something to serve other than the camera master. Nullable with no
backfill: every version transcoded before this has no such object, and the
download path falls back to the raw master when the column is NULL.

Revision ID: e3a7c9d4b210
Revises: cdcf8e5a6437
Create Date: 2026-09-11

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e3a7c9d4b210'
down_revision: Union[str, Sequence[str], None] = 'cdcf8e5a6437'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('media_files', sa.Column('s3_key_download', sa.String(length=1000), nullable=True))


def downgrade() -> None:
    op.drop_column('media_files', 's3_key_download')
