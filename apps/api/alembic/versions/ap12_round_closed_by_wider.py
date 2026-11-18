"""Embed round close: feedback_rounds.closed_by gains 'left' and 'all_reviewed' (12 chars) - widen String(10) to String(16)."""
from alembic import op
import sqlalchemy as sa

revision = 'ap12_round_closed_by_wider'
down_revision = 'ap11_handin_sign_initials'
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column('feedback_rounds', 'closed_by', type_=sa.String(16), existing_type=sa.String(10), existing_nullable=True)


def downgrade():
    op.alter_column('feedback_rounds', 'closed_by', type_=sa.String(10), existing_type=sa.String(16), existing_nullable=True)
