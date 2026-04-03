"""add share_link_items table

Revision ID: 8ca3dffea55f
Revises: f9a0b1c2d3e4
Create Date: 2026-04-03 14:43:58.909837

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '8ca3dffea55f'
down_revision: Union[str, Sequence[str], None] = 'f9a0b1c2d3e4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create share_link_items table for multi-item share links."""
    op.create_table('share_link_items',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('share_link_id', sa.UUID(), nullable=False),
        sa.Column('asset_id', sa.UUID(), nullable=True),
        sa.Column('folder_id', sa.UUID(), nullable=True),
        sa.CheckConstraint(
            '(asset_id IS NOT NULL AND folder_id IS NULL) OR (asset_id IS NULL AND folder_id IS NOT NULL)',
            name='ck_share_link_item_asset_or_folder',
        ),
        sa.ForeignKeyConstraint(['asset_id'], ['assets.id']),
        sa.ForeignKeyConstraint(['folder_id'], ['folders.id']),
        sa.ForeignKeyConstraint(['share_link_id'], ['share_links.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_share_link_items_share_link_id', 'share_link_items', ['share_link_id'], unique=False)


def downgrade() -> None:
    """Drop share_link_items table."""
    op.drop_index('ix_share_link_items_share_link_id', table_name='share_link_items')
    op.drop_table('share_link_items')
