"""add PDF asset support and page anchors for comments

Revision ID: e1f2a3b4c5d6
Revises: cdcf8e5a6437
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e1f2a3b4c5d6"
down_revision: Union[str, Sequence[str], None] = "cdcf8e5a6437"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # PostgreSQL enum values must be added before application rows can use them.
    op.execute("ALTER TYPE assettype ADD VALUE IF NOT EXISTS 'pdf'")
    op.execute("ALTER TYPE filetype ADD VALUE IF NOT EXISTS 'pdf'")
    op.add_column("comments", sa.Column("page_number", sa.Integer(), nullable=True))
    op.create_check_constraint(
        "ck_comments_page_number_positive", "comments", "page_number > 0"
    )


def downgrade() -> None:
    op.drop_constraint("ck_comments_page_number_positive", "comments", type_="check")
    op.drop_column("comments", "page_number")
    # PostgreSQL does not support removing enum values safely. Leave the values
    # in place so downgrades preserve data and remain operational.
