"""Agent-readable feedback: attachment kind/version/t/meta, persisted dictations, comment dictation link + frame status."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'ap13_agent_readable_feedback'
down_revision = 'ap12_round_closed_by_wider'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'comment_dictations',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('version_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('asset_versions.id'), nullable=False),
        sa.Column('text', sa.Text(), nullable=False),
        sa.Column('raw_text', sa.Text(), nullable=True),
        sa.Column('lang', sa.String(8), nullable=True),
        sa.Column('words', postgresql.JSONB(), nullable=False, server_default='[]'),
        sa.Column('segments', postgresql.JSONB(), nullable=False, server_default='[]'),
        sa.Column('audio_attachment_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index('ix_comment_dictations_version_id', 'comment_dictations', ['version_id'])
    op.add_column('comments', sa.Column('dictation_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('comment_dictations.id'), nullable=True))
    op.add_column('comments', sa.Column('segment_index', sa.Integer(), nullable=True))
    op.add_column('comments', sa.Column('frame_status', sa.String(12), nullable=True))
    op.create_index('ix_comments_dictation_id', 'comments', ['dictation_id'])
    op.add_column('comment_attachments', sa.Column('kind', sa.String(20), nullable=False, server_default='reference_image'))
    op.add_column('comment_attachments', sa.Column('version_id', postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column('comment_attachments', sa.Column('t', sa.Float(), nullable=True))
    op.add_column('comment_attachments', sa.Column('meta', postgresql.JSONB(), nullable=True))


def downgrade():
    for c in ('meta', 't', 'version_id', 'kind'):
        op.drop_column('comment_attachments', c)
    op.drop_index('ix_comments_dictation_id', table_name='comments')
    for c in ('frame_status', 'segment_index', 'dictation_id'):
        op.drop_column('comments', c)
    op.drop_index('ix_comment_dictations_version_id', table_name='comment_dictations')
    op.drop_table('comment_dictations')
