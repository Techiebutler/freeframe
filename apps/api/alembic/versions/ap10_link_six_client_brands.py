"""Link six client workspaces to their AutoReview brands (V4, Alan 2026-11-17 "6 andere auch").

Same cure as ap06/ap07/ap08: without the slug `list_rules` / `start_import` answer unknown_brand for the
workspace, so its brand rules never reach the agent. Every slug is the review service's own brand key
(feedback-agent src/seed.ts), never derived from the name here. By id, only where no slug is set yet -
a slug set by hand always wins.
"""
from alembic import op
import sqlalchemy as sa

revision = 'ap10_link_six_client_brands'
down_revision = 'ap09_handin_signs'
branch_labels = None
depends_on = None

# project id (list_brands brand_id) -> review brand slug (feedback-agent seed.ts line)
LINKS = {
    '824ea88f-7415-4cf1-a49a-a0e13249de50': 'lior',                 # Lior, seed.ts:30
    '7af8b23e-4ba5-425a-baec-b209487ac556': 'peaq-skin',            # PEAQ Skin, seed.ts:37
    'da8e27f8-5dc6-43fa-8270-3098b27db3c1': 'rugsak',               # RUGSAK, seed.ts:38
    'dc7c199d-f4a9-4097-8508-041b7f4fd2d1': 'source-werbeartikel',  # Source Werbeartikel, seed.ts:41
    '92b900cf-e19c-413e-9137-8a9c25312b6a': 'timothy-mitchum',      # Timothy Mitchum, seed.ts:43
    'c8acf22c-a079-4f16-b53b-af27b1fe1922': 'veloura',              # Veloura, seed.ts:47
}


def upgrade():
    # op.execute (not get_bind) so `alembic upgrade --sql` renders it too.
    for pid, slug in LINKS.items():
        op.execute(sa.text("UPDATE projects SET autoreview_brand_slug = :slug "
                           "WHERE id = :id AND autoreview_brand_slug IS NULL")
                   .bindparams(slug=slug, id=pid))


def downgrade():
    # ponytail: no-op - a rollback must not wipe a slug someone set by hand since.
    pass
