"""A new file reopens a finished request; keep that it already finished once."""
from alembic import op
import sqlalchemy as sa

revision = 'a7c2e4f6b8d0'
down_revision = 'd1a2b3c4e5f6'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('upload_requests', sa.Column('first_completed_at', sa.DateTime(timezone=True), nullable=True))


def downgrade():
    op.drop_column('upload_requests', 'first_completed_at')
