"""add share_previews_enabled to instance_settings

The instance-level master switch for share-link OG/Twitter preview data
(`GET /share/{token}/preview*`, routers/share.py). Defaults to on, so existing
instances start unfurling rich share cards the moment they upgrade, and an
operator turns the feature off with a single row update (see
`PUT /instance/settings`).

Revision ID: c9d3e7b2a6f4
Revises: e3a7c1d9b5f2
Create Date: 2026-10-16

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'c9d3e7b2a6f4'
down_revision: Union[str, Sequence[str], None] = 'e3a7c1d9b5f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'instance_settings',
        sa.Column('share_previews_enabled', sa.Boolean(), nullable=False,
                  server_default=sa.text('true')),
    )


def downgrade() -> None:
    op.drop_column('instance_settings', 'share_previews_enabled')
