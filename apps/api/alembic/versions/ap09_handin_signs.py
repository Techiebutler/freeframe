"""V3 part C: handin_signs, the agent-prepared hand-in a staff member signs (additive only)."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'ap09_handin_signs'
down_revision = 'ap08_link_veda_naturals_brand'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'handin_signs',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('request_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('upload_requests.id'), nullable=False),
        sa.Column('asset_ids', postgresql.JSONB(), nullable=False),
        sa.Column('client_text', sa.Text(), nullable=False, server_default=''),
        sa.Column('prepared_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('prepared_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('token_hash', sa.String(64), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('signed_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('signed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('share_token', sa.String(255), nullable=True),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index('ix_handin_signs_request_id', 'handin_signs', ['request_id'])


def downgrade():
    op.drop_index('ix_handin_signs_request_id', table_name='handin_signs')
    op.drop_table('handin_signs')
