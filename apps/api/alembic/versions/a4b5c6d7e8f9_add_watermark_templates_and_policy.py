"""add watermark templates and policy fields

Revision ID: a4b5c6d7e8f9
Revises: 8ca3dffea55f
Create Date: 2026-06-10 17:30:00.000000

"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'a4b5c6d7e8f9'
down_revision: Union[str, Sequence[str], None] = '8ca3dffea55f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


DEFAULT_TEMPLATES = [
    {
        "name": "Viewer email — centered",
        "blocks": [
            {
                "field": "email", "custom_text": None,
                "x": 50, "y": 50, "size": 4, "color": "#FFFFFF",
                "opacity": 0.35, "rotation": -30, "shadow": True,
                "scroll": False, "tiled": False,
            },
            {
                "field": "date", "custom_text": None,
                "x": 50, "y": 60, "size": 2.5, "color": "#FFFFFF",
                "opacity": 0.3, "rotation": -30, "shadow": False,
                "scroll": False, "tiled": False,
            },
        ],
    },
    {
        "name": "Viewer name — tiled",
        "blocks": [
            {
                "field": "name", "custom_text": None,
                "x": 50, "y": 50, "size": 3, "color": "#FFFFFF",
                "opacity": 0.22, "rotation": -30, "shadow": False,
                "scroll": False, "tiled": True,
            },
        ],
    },
    {
        "name": "Confidential — corner",
        "blocks": [
            {
                "field": "custom_text", "custom_text": "CONFIDENTIAL",
                "x": 85, "y": 93, "size": 3, "color": "#FFFFFF",
                "opacity": 0.5, "rotation": 0, "shadow": True,
                "scroll": False, "tiled": False,
            },
        ],
    },
]


def upgrade() -> None:
    """Create watermark_templates, extend watermark_settings and share_links."""
    watermark_templates = op.create_table(
        'watermark_templates',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column(
            'scope',
            sa.Enum('instance', 'project', name='watermarktemplatescope'),
            nullable=False,
            server_default='project',
        ),
        sa.Column('project_id', sa.UUID(), nullable=True),
        sa.Column('blocks', sa.JSON(), nullable=False, server_default='[]'),
        sa.Column('created_by', sa.UUID(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id']),
        sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_watermark_templates_project_id', 'watermark_templates', ['project_id'], unique=False)

    # watermark_settings: policy fields + allow an instance-wide row (project_id NULL)
    op.alter_column('watermark_settings', 'project_id', existing_type=sa.UUID(), nullable=True)
    op.add_column('watermark_settings', sa.Column('require_internal', sa.Boolean(), nullable=False, server_default='false'))
    op.add_column('watermark_settings', sa.Column('require_shares', sa.Boolean(), nullable=False, server_default='false'))
    op.add_column('watermark_settings', sa.Column('template_id', sa.UUID(), nullable=True))
    op.add_column('watermark_settings', sa.Column('exempt_roles', sa.JSON(), nullable=False, server_default='["owner", "editor"]'))
    op.add_column('watermark_settings', sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False))
    op.create_foreign_key(
        'fk_watermark_settings_template_id', 'watermark_settings',
        'watermark_templates', ['template_id'], ['id'],
    )

    # share_links: per-share template override
    op.add_column('share_links', sa.Column('watermark_template_id', sa.UUID(), nullable=True))
    op.create_foreign_key(
        'fk_share_links_watermark_template_id', 'share_links',
        'watermark_templates', ['watermark_template_id'], ['id'],
    )

    # Seed instance-wide starter templates so teams have working defaults
    op.bulk_insert(
        watermark_templates,
        [
            {
                'id': uuid.uuid4(),
                'name': tpl['name'],
                'scope': 'instance',
                'project_id': None,
                'blocks': tpl['blocks'],
                'created_by': None,
            }
            for tpl in DEFAULT_TEMPLATES
        ],
    )


def downgrade() -> None:
    """Remove watermark templates and policy fields."""
    op.drop_constraint('fk_share_links_watermark_template_id', 'share_links', type_='foreignkey')
    op.drop_column('share_links', 'watermark_template_id')

    op.drop_constraint('fk_watermark_settings_template_id', 'watermark_settings', type_='foreignkey')
    op.drop_column('watermark_settings', 'updated_at')
    op.drop_column('watermark_settings', 'exempt_roles')
    op.drop_column('watermark_settings', 'template_id')
    op.drop_column('watermark_settings', 'require_shares')
    op.drop_column('watermark_settings', 'require_internal')
    op.execute('DELETE FROM watermark_settings WHERE project_id IS NULL')
    op.alter_column('watermark_settings', 'project_id', existing_type=sa.UUID(), nullable=False)

    op.drop_index('ix_watermark_templates_project_id', table_name='watermark_templates')
    op.drop_table('watermark_templates')
    op.execute('DROP TYPE IF EXISTS watermarktemplatescope')
