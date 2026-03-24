"""add project_id to share_links for project root sharing

Revision ID: e8f9a0b1c2d3
Revises: d7e8f9a0b1c2
Create Date: 2026-03-24
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision: str = 'e8f9a0b1c2d3'
down_revision: Union[str, Sequence[str], None] = 'd7e8f9a0b1c2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('share_links', sa.Column('project_id', UUID(as_uuid=True), sa.ForeignKey('projects.id'), nullable=True))
    op.create_index('ix_share_links_project_id', 'share_links', ['project_id'])
    # Drop old constraint and add new one that includes project_id
    op.drop_constraint('ck_share_link_asset_or_folder', 'share_links', type_='check')
    op.create_check_constraint(
        'ck_share_link_asset_or_folder_or_project',
        'share_links',
        "(asset_id IS NOT NULL AND folder_id IS NULL AND project_id IS NULL) "
        "OR (asset_id IS NULL AND folder_id IS NOT NULL AND project_id IS NULL) "
        "OR (asset_id IS NULL AND folder_id IS NULL AND project_id IS NOT NULL)"
    )


def downgrade() -> None:
    # Remove any project-level share links before re-adding old constraint
    op.execute("DELETE FROM share_links WHERE project_id IS NOT NULL")
    op.drop_constraint('ck_share_link_asset_or_folder_or_project', 'share_links', type_='check')
    op.create_check_constraint(
        'ck_share_link_asset_or_folder',
        'share_links',
        "(asset_id IS NOT NULL AND folder_id IS NULL) OR (asset_id IS NULL AND folder_id IS NOT NULL)"
    )
    op.drop_index('ix_share_links_project_id', 'share_links')
    op.drop_column('share_links', 'project_id')
