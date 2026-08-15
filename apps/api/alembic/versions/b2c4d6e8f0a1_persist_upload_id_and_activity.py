"""persist the S3 upload id and last upload activity on asset_versions

The multipart upload id was never stored anywhere, so nothing server-side could
answer "which S3 upload does this version belong to". That left two known holes:
the stale-upload reaper had to sweep the whole bucket to find abandoned uploads,
and `/upload/presign-part` signed whatever upload id the caller handed it because
there was nothing to check it against.

`last_activity_at` exists because the reaper currently ages uploads by when they
were *started*. An upload slower than the window is aborted while it is still
running, which on a connection this project explicitly supports is not a corner
case.

Also indexes media_files.s3_key_raw, which `/upload/presign-part` looks up once
per part -- 10,000 sequential scans on a large upload, several concurrently since
parts now upload in parallel.

Revision ID: b2c4d6e8f0a1
Revises: a9ee0209151a
Create Date: 2026-08-15
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = 'b2c4d6e8f0a1'
down_revision: Union[str, Sequence[str], None] = 'a9ee0209151a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable with no backfill: existing rows predate this and their uploads are
    # long finished or long abandoned. Consumers must treat NULL as "unknown" and
    # fall back to current behaviour rather than assuming a value is present.
    op.add_column('asset_versions', sa.Column('upload_id', sa.String(length=255), nullable=True))
    op.add_column(
        'asset_versions',
        sa.Column('last_activity_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        'ix_media_files_s3_key_raw', 'media_files', ['s3_key_raw'], unique=False
    )


def downgrade() -> None:
    op.drop_index('ix_media_files_s3_key_raw', table_name='media_files')
    op.drop_column('asset_versions', 'last_activity_at')
    op.drop_column('asset_versions', 'upload_id')
