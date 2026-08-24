"""add pdf document asset type

Revision ID: a1b2c3d4e5f6
Revises: f9a0b1c2d3e4
"""
from alembic import op

revision = "a1b2c3d4e5f6"
down_revision = "f9a0b1c2d3e4"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TYPE assettype ADD VALUE IF NOT EXISTS 'document'")
    op.execute("ALTER TYPE filetype ADD VALUE IF NOT EXISTS 'document'")


def downgrade():
    # PostgreSQL enums cannot remove values safely; no-op downgrade.
    pass
