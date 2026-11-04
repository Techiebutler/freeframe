"""Self-review: an agent files a card by external ref; one request per (project, ref)."""
from alembic import op
import sqlalchemy as sa

revision = 'ap02_request_external_ref'
down_revision = 'ap01_agent_review'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('upload_requests', sa.Column('external_ref', sa.String(200), nullable=True))
    op.create_index('uq_upload_requests_project_external_ref', 'upload_requests', ['project_id', 'external_ref'],
                    unique=True, postgresql_where=sa.text('external_ref IS NOT NULL'))


def downgrade():
    op.drop_index('uq_upload_requests_project_external_ref', table_name='upload_requests')
    op.drop_column('upload_requests', 'external_ref')
