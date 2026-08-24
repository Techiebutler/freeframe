"""add short_code column to share_links

Revision ID: 7c3a9d4b1e2f
Revises: cdcf8e5a6437
Create Date: 2026-08-24 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '7c3a9d4b1e2f'
down_revision: Union[str, None] = 'cdcf8e5a6437'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'share_links',
        sa.Column('short_code', sa.String(10), nullable=True)
    )
    op.create_index(
        op.f('ix_share_links_short_code'),
        'share_links',
        ['short_code'],
        unique=True
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_share_links_short_code'), table_name='share_links')
    op.drop_column('share_links', 'short_code')
