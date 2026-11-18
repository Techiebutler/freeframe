"""add avatar_color column to users

Revision ID: b8e3d5f7a921
Revises: b8c4d2e6f913
Create Date: 2026-10-12
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = 'b8e3d5f7a921'
down_revision: Union[str, Sequence[str], None] = 'b8c4d2e6f913'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('users', sa.Column('avatar_color', sa.String(length=7), nullable=True))


def downgrade() -> None:
    op.drop_column('users', 'avatar_color')
