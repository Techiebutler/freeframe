"""Comments survive a double tap: an Idempotency-Key per author, unique when set."""
from alembic import op
import sqlalchemy as sa

revision = 'ap03_comment_idempotency_key'
down_revision = 'ap02_request_external_ref'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('comments', sa.Column('idempotency_key', sa.String(200), nullable=True))
    op.create_index('uq_comments_idempotency_key', 'comments', ['idempotency_key'], unique=True,
                    postgresql_where=sa.text('idempotency_key IS NOT NULL'))


def downgrade():
    op.drop_index('uq_comments_idempotency_key', table_name='comments')
    op.drop_column('comments', 'idempotency_key')
