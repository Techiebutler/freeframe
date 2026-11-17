"""Link the Veda Naturals workspace to its AutoReview brand `veda-naturals` (V4, Alan 2026-11-17).

Without the slug `list_rules` / `start_import` answer unknown_brand for Veda (the alias in
/agent/brands is only this column), so the five Veda rules never reach the agent and Aditor's
home brand is what it reads. `veda-naturals` is the review service's brand (feedback-agent seed.ts).
By id, only where no slug is set yet - a slug set by hand always wins. Same cure as ap06/ap07.
"""
from alembic import op
import sqlalchemy as sa

revision = 'ap08_link_veda_naturals_brand'
down_revision = 'd3l1v3r1e5'
branch_labels = None
depends_on = None

VEDA_PROJECT_ID = '8254e4d9-6cfb-4cac-91ca-ec72449c3991'


def upgrade():
    # op.execute (not get_bind) so `alembic upgrade --sql` renders it too.
    op.execute(sa.text("UPDATE projects SET autoreview_brand_slug = 'veda-naturals' "
                       "WHERE id = :id AND autoreview_brand_slug IS NULL")
               .bindparams(id=VEDA_PROJECT_ID))


def downgrade():
    # ponytail: no-op - a rollback must not wipe a slug someone set by hand since.
    pass
