"""feat: add token_version to user model

Revision ID: a9ee0209151a
Revises: 54b1ad156f8f
Create Date: 2026-07-17 08:14:18.670591

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'a9ee0209151a'
down_revision: Union[str, Sequence[str], None] = '54b1ad156f8f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    # Add the column with a server_default to prevent crashing on existing rows
    op.add_column('users', sa.Column('token_version', sa.Integer(), server_default='1', nullable=False))


def downgrade() -> None:
    # Safely remove the column if the migration is rolled back
    op.drop_column('users', 'token_version')