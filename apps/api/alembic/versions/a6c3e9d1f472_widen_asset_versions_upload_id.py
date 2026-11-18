"""widen asset_versions.upload_id to text

The multipart upload id came in as varchar(255) (b2c4d6e8f0a1, v1.9.0). S3
documents no maximum length for an UploadId, and Cloudflare R2 issues ids of
343 characters, so on R2 both initiate routes failed on the commit that records
the id: every upload and every new version answered 500, and each attempt left
the multipart upload it had already created behind in the bucket (#637).

Text rather than a wider varchar, because any number picked here is another
guess about a value the storage backend owns. On PostgreSQL, widening varchar
to text is a catalog-only change: the table is not rewritten and no index
covers the column, so this is instant on any size of table.

The downgrade has to fit the values back into 255 characters and it does not
truncate them: a shortened id names a different upload, or none, and every
call made with it would fail or touch the wrong one. Ids longer than 255 are
set to NULL instead, which is the state of a row from before v1.9.0 and is
handled as "unknown" everywhere. What that costs those versions: an in-flight
upload can no longer be resumed (GET /upload/{version_id}/parts answers 409),
and presign-part, complete and abort go back to trusting the upload id the
caller sends, as they did before v1.9.0. Nothing can abort such an upload by
its id any more either: the stale-upload reaper and the retention purge both
need the version's upload_id to do that. The reaper's bucket-wide sweep is
the only backstop FreeFrame itself has, and it skips any key a media_files row
still names, so it reaches the upload only after the retention purge has
deleted that row, and only on a backend whose ListMultipartUploads works.
Past that, only the bucket's own lifecycle rule for incomplete uploads, where
one is set (docs/deployment.md), cleans it up. Narrowing is not catalog-only
either: PostgreSQL rewrites the table under an exclusive lock, for as long as
the table's size takes.

Revision ID: a6c3e9d1f472
Revises: f4b9c2a7d105
Create Date: 2026-11-18

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a6c3e9d1f472'
down_revision: Union[str, Sequence[str], None] = 'f4b9c2a7d105'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        'asset_versions', 'upload_id',
        existing_type=sa.String(length=255),
        type_=sa.Text(),
        existing_nullable=True,
    )


def downgrade() -> None:
    # NULL, never truncated; see the docstring.
    op.execute("UPDATE asset_versions SET upload_id = NULL WHERE length(upload_id) > 255")
    op.alter_column(
        'asset_versions', 'upload_id',
        existing_type=sa.Text(),
        type_=sa.String(length=255),
        existing_nullable=True,
    )
