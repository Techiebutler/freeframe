"""Link Aditor's own workspace to its AutoReview brand `aditor` (Alan, 2026-11-09).

Without the slug FreeFrame never forwards Alan's comments to the Brand Loop and `list_rules`
answers unknown_brand for the Aditor project. By id, only where no slug is set yet - a slug
set by hand always wins.
"""
from alembic import op
import sqlalchemy as sa

revision = 'ap06_link_aditor_brand'
down_revision = 'ap05_comment_attachment_upload'
branch_labels = None
depends_on = None

ADITOR_PROJECT_ID = '0f353bd9-c353-4cfd-97d9-2997afb47feb'


def upgrade():
    # op.execute (not get_bind) so `alembic upgrade --sql` renders it too.
    op.execute(sa.text("UPDATE projects SET autoreview_brand_slug = 'aditor' "
                       "WHERE id = :id AND is_workspace AND autoreview_brand_slug IS NULL")
               .bindparams(id=ADITOR_PROJECT_ID))


def downgrade():
    # ponytail: no-op - a rollback must not wipe a slug someone set by hand since.
    pass
