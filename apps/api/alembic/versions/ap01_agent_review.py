"""Agent-review platform: agent users, keys, pairing codes, feedback rounds."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'ap01_agent_review'
down_revision = 'a7c2e4f6b8d0'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('kind', sa.String(10), nullable=False, server_default='human'))
    op.add_column('projects', sa.Column('agents_may_approve', sa.Boolean(), nullable=False, server_default='false'))
    op.create_table(
        'agent_keys',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('project_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('projects.id'), nullable=False),
        sa.Column('program', sa.String(20), nullable=False),
        sa.Column('agent_name', sa.String(80), nullable=False),
        sa.Column('key_hash', sa.String(64), nullable=False, unique=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint('project_id', 'program', 'agent_name', name='uq_agent_keys_project_program_name'),
    )
    op.create_index('ix_agent_keys_user_id', 'agent_keys', ['user_id'])
    op.create_index('ix_agent_keys_project_id', 'agent_keys', ['project_id'])
    op.create_table(
        'agent_pairing_codes',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('project_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('projects.id'), nullable=False),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('code_hash', sa.String(64), nullable=False, unique=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('used_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index('ix_agent_pairing_codes_project_id', 'agent_pairing_codes', ['project_id'])
    op.create_table(
        'feedback_rounds',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('request_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('upload_requests.id'), nullable=False),
        sa.Column('opened_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('closed_by', sa.String(10), nullable=True),
        sa.Column('last_activity_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('acked_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('rule_suggestions', sa.JSON(), nullable=False, server_default='[]'),
    )
    op.create_index('ix_feedback_rounds_request_id', 'feedback_rounds', ['request_id'])
    op.create_index('uq_feedback_rounds_one_open', 'feedback_rounds', ['request_id'], unique=True, postgresql_where=sa.text('closed_at IS NULL'))


def downgrade():
    op.drop_table('feedback_rounds')
    op.drop_table('agent_pairing_codes')
    op.drop_table('agent_keys')
    op.drop_column('projects', 'agents_may_approve')
    op.drop_column('users', 'kind')
