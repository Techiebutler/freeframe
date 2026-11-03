"""add derived_size_bytes to media_files

The admin storage overview reports originals and derived output separately, and
derived output (HLS renditions, the MP4/MP3/WebP, thumbnails, waveforms) has no
size anywhere in the database. The transcode job now measures it once by listing
its own output prefix and writes it here, so the overview is a grouped SUM
rather than a bucket listing on every page view.

Nullable with no server default and no data backfill in the migration: NULL
means "not measured", which is exactly true of every row written before this
column existed, and the overview counts those rows as unmeasured instead of
claiming they derived nothing. `backfill_media_derived_size` fills them in from
S3 afterwards, in the worker, where a long listing belongs.

BigInteger, like `file_size_bytes`: an HLS ladder of a long master passes 2^31
bytes on its own.

It also pins what the column counts. The figure is measured for a *version's*
output prefix but stored per media file, and today there is exactly one media
file per version on every write path. A second row on the same version would
make the overview count that prefix twice with nothing going red, so the
assumption becomes a unique constraint rather than a comment. A version that
has to hold several files is then a decision, and the total belongs on
`asset_versions` at that point.

Revision ID: f4b9c2a7d105
Revises: c5d1f3a7b9e2
Create Date: 2026-10-28

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f4b9c2a7d105'
down_revision: Union[str, Sequence[str], None] = 'c5d1f3a7b9e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'media_files',
        sa.Column('derived_size_bytes', sa.BigInteger(), nullable=True),
    )
    # Checked before the constraint so an instance that somehow holds two media
    # files on one version gets a sentence it can act on instead of a bare
    # "could not create unique index".
    duplicates = op.get_bind().execute(sa.text(
        "SELECT version_id, count(*) FROM media_files "
        "GROUP BY version_id HAVING count(*) > 1"
    )).fetchall()
    if duplicates:
        raise RuntimeError(
            "media_files holds more than one row for these versions, so the "
            "derived-bytes figure cannot be attributed to one of them: "
            + ", ".join(f"{v} ({n} rows)" for v, n in duplicates)
            + ". Keep the row the version's asset is actually served from — the "
            "one whose s3_key_raw and s3_key_processed match the objects in the "
            "bucket, which on an upload that was retried is the newest row by "
            "created_at — and delete the others. This upgrade has changed "
            "nothing: it runs in one transaction, so the new column is rolled "
            "back with it and your database is exactly as it was. Run the "
            "migration again once the duplicates are gone."
        )
    op.create_unique_constraint('uq_media_files_version_id', 'media_files', ['version_id'])


def downgrade() -> None:
    op.drop_constraint('uq_media_files_version_id', 'media_files', type_='unique')
    op.drop_column('media_files', 'derived_size_bytes')
