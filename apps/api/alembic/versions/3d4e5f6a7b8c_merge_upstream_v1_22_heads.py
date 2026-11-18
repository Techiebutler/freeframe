"""merge the fork's head with upstream's v1.22 head

Revision ID: 3d4e5f6a7b8c
Revises: 2c3d4e5f6a7b, f4b9c2a7d105
Create Date: 2026-11-18
"""

from typing import Sequence, Union


revision: str = "3d4e5f6a7b8c"
down_revision: Union[str, Sequence[str], None] = ("2c3d4e5f6a7b", "f4b9c2a7d105")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
