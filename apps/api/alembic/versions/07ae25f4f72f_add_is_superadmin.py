"""add_is_superadmin

Revision ID: 07ae25f4f72f
Revises: a3e10e1e5635
Create Date: 2026-03-19 15:56:28.444135

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '07ae25f4f72f'
down_revision: Union[str, Sequence[str], None] = 'a3e10e1e5635'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('users', sa.Column('is_superadmin', sa.Boolean(), nullable=False))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('users', 'is_superadmin')
