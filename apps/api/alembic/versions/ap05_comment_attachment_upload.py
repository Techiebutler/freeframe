"""Comment images: an attachment counts once uploaded; a comment says how many images follow.

Existing attachments are backfilled as uploaded (uploaded_at = created_at) so none disappears.

Revision ID: ap05_comment_attachment_upload
Revises: ap04_agent_key_scope
"""
import sqlalchemy as sa
from alembic import op

revision = 'ap05_comment_attachment_upload'
down_revision = 'ap04_agent_key_scope'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('comment_attachments', sa.Column('uploaded_at', sa.DateTime(timezone=True), nullable=True))
    op.execute("UPDATE comment_attachments SET uploaded_at = created_at WHERE uploaded_at IS NULL")
    op.add_column('comments', sa.Column('attachments_expected', sa.Integer(), nullable=False, server_default='0'))


def downgrade() -> None:
    op.drop_column('comments', 'attachments_expected')
    op.drop_column('comment_attachments', 'uploaded_at')
