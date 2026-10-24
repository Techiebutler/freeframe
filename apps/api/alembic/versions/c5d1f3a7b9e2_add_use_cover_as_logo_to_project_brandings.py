"""add use_cover_as_logo to project_brandings

Lets a project show its cover image as the logo on its share pages. Off for
every existing project, so no share page changes until an owner turns it on.

Revision ID: c5d1f3a7b9e2
Revises: e3a7c1d9b5f2
Create Date: 2026-10-24
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = 'c5d1f3a7b9e2'
down_revision: Union[str, Sequence[str], None] = 'e3a7c1d9b5f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'project_brandings',
        sa.Column('use_cover_as_logo', sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column('project_brandings', 'use_cover_as_logo')
