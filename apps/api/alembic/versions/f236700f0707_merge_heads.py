"""merge heads

Revision ID: f236700f0707
Revises: a7e3c5d90b42, 74cc6317c7f9
Create Date: 2026-11-22 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f236700f0707'
down_revision: Union[str, Sequence[str], None] = ('a7e3c5d90b42', '74cc6317c7f9')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
