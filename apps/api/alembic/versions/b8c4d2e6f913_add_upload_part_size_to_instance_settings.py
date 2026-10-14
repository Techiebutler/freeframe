"""add upload_part_size_bytes to instance_settings

The size uploads are cut into. 0 (the default) sizes parts from each file; any
other value is a fixed part size an admin chose.

Revision ID: b8c4d2e6f913
Revises: d2b7e5f9a1c3
Create Date: 2026-10-12
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = 'b8c4d2e6f913'
down_revision: Union[str, Sequence[str], None] = 'd2b7e5f9a1c3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'instance_settings',
        sa.Column('upload_part_size_bytes', sa.BigInteger(), nullable=False, server_default='0'),
    )


def downgrade() -> None:
    op.drop_column('instance_settings', 'upload_part_size_bytes')
