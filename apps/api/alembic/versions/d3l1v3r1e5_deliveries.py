"""Deliveries: the tokened hand-off page an approval creates (additive only).

Known gotcha: once this ran, redeploying an OLDER commit makes its `alembic upgrade head` fail
("Can't locate revision d3l1v3r1e5") and the API crashes. Never follow the deploy of this with an
old-commit redeploy; roll forward instead.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'd3l1v3r1e5'
down_revision = 'ap07_link_alan_denkt_brand'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'deliveries',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('token', sa.String(64), nullable=False),
        sa.Column('request_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('upload_requests.id'), nullable=True),
        sa.Column('asset_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('assets.id'), nullable=False),
        sa.Column('version_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('asset_versions.id'), nullable=False),
        sa.Column('approved_by', sa.String(255), nullable=False),
        sa.Column('approved_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('handed_on_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('file_hashes', postgresql.JSONB(), nullable=True),
        sa.UniqueConstraint('asset_id', 'version_id', name='uq_deliveries_asset_version'),
    )
    op.create_index('ix_deliveries_token', 'deliveries', ['token'], unique=True)
    op.create_index('ix_deliveries_request_id', 'deliveries', ['request_id'])
    op.create_index('ix_deliveries_asset_id', 'deliveries', ['asset_id'])


def downgrade():
    op.drop_table('deliveries')
