"""V3 C follow-up: the signer's initials and the rules they accepted, kept with the signature (additive only)."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'ap11_handin_sign_initials'
down_revision = 'ap10_link_six_client_brands'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('handin_signs', sa.Column('initials_png', sa.Text(), nullable=True))
    op.add_column('handin_signs', sa.Column('terms', postgresql.JSONB(), nullable=True))


def downgrade():
    op.drop_column('handin_signs', 'terms')
    op.drop_column('handin_signs', 'initials_png')
