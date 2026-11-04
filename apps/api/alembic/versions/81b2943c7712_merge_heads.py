"""merge heads

Revision ID: 81b2943c7712
Revises: f236700f0707, 9d2e5b7c41a8
Create Date: 2026-11-27 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '81b2943c7712'
down_revision: Union[str, Sequence[str], None] = ('f236700f0707', '9d2e5b7c41a8')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
