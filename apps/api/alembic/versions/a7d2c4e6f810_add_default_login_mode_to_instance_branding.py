"""add default_login_mode to instance_branding

Which sign-in form the login page opens on. Default stays as Magic Code, but can be switched to Email/Password.

Revision ID: a7d2c4e6f810
Revises: e3f5a7c9d1b2
Create Date: 2026-10-07
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = 'a7d2c4e6f810'
down_revision: Union[str, Sequence[str], None] = 'e3f5a7c9d1b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'instance_branding',
        sa.Column('default_login_mode', sa.String(length=16), nullable=False, server_default='magic_code'),
    )


def downgrade() -> None:
    op.drop_column('instance_branding', 'default_login_mode')
