"""add allow_original_downloads to instance_settings, rendition to share_link_activity

Whether people outside a project (share-link visitors, public-project visitors,
direct shares) may download an asset's original upload rather than its
transcode. Off by default, which keeps what those downloads served before there
was a choice. The activity column records which file a download handed out.

Revision ID: e3a7c1d9b5f2
Revises: b8e3d5f7a921
Create Date: 2026-10-16
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = 'e3a7c1d9b5f2'
down_revision: Union[str, Sequence[str], None] = 'b8e3d5f7a921'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'instance_settings',
        sa.Column('allow_original_downloads', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        'share_link_activity',
        sa.Column('rendition', sa.String(length=32), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('share_link_activity', 'rendition')
    op.drop_column('instance_settings', 'allow_original_downloads')
