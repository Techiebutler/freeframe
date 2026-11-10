"""Link Alan's personal workspace "Alan Denkt" to its AutoReview brand `alan-denkt` (Alan, 2026-11-11).

Without the slug `list_rules` answers unknown_brand for the Alan Denkt project and the 12
alan-denkt rules (flex edits + YouTube longform, feedback-agent #150/#183) never apply. By id,
only where no slug is set yet - a slug set by hand always wins.
"""
from alembic import op
import sqlalchemy as sa

revision = 'ap07_link_alan_denkt_brand'
down_revision = 'ap06_link_aditor_brand'
branch_labels = None
depends_on = None

ALAN_DENKT_PROJECT_ID = '3aef3408-6ba0-444c-b4af-b1bfd02ce0c7'


def upgrade():
    # op.execute (not get_bind) so `alembic upgrade --sql` renders it too.
    op.execute(sa.text("UPDATE projects SET autoreview_brand_slug = 'alan-denkt' "
                       "WHERE id = :id AND is_workspace AND autoreview_brand_slug IS NULL")
               .bindparams(id=ALAN_DENKT_PROJECT_ID))


def downgrade():
    # ponytail: no-op - a rollback must not wipe a slug someone set by hand since.
    pass
