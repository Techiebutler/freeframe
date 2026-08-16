"""add_instance_branding_table

Revision ID: cdcf8e5a6437
Revises: b2c4d6e8f0a1
Create Date: 2026-07-04 08:54:52.624461

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'cdcf8e5a6437'
down_revision: Union[str, Sequence[str], None] = 'b2c4d6e8f0a1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table("instance_branding",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("org_name", sa.String(length=255), server_default="FreeFrame", nullable=False),
        sa.Column("logo_light_key", sa.String(length=512), nullable=True),
        sa.Column("logo_dark_key", sa.String(length=512), nullable=True),
        sa.Column("favicon_key", sa.String(length=512), nullable=True),
        sa.Column("apple_icon_key", sa.String(length=512), nullable=True),
        sa.Column("login_logo_key", sa.String(length=512), nullable=True),
        sa.Column("primary_color", sa.String(length=7), nullable=True),
        sa.Column("powered_by_freeframe", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id")
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("instance_branding")
