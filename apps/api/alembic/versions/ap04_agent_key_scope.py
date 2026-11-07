"""Agent keys get a scope: read or deliver. Existing keys stay deliver (Agent Mode spec E)."""
from alembic import op
import sqlalchemy as sa

revision = 'ap04_agent_key_scope'
down_revision = 'ap03_comment_idempotency_key'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('agent_keys', sa.Column('scope', sa.String(10), nullable=False, server_default='deliver'))


def downgrade():
    op.drop_column('agent_keys', 'scope')
