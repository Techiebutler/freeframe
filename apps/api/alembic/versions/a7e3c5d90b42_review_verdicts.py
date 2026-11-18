"""review verdicts: guests can hold a verdict, and "changes requested" is a status

An approval was a signed-in user's row, one per (version, user). A verdict is now
also something a guest gives through a share link, and there is a third value
besides approved and rejected.

approvals
  * `user_id` becomes nullable and `guest_user_id` is added. Exactly one of them
    is set (`ck_approvals_one_actor`).
  * `uq_approvals_version_user` becomes two partial unique indexes, one per actor
    kind, because a plain unique constraint on (version_id, user_id) lets any
    number of guest rows through (their user_id is NULL) and says nothing about
    guests. Each is partial so a row of the other kind never takes part.
  * `share_link_id` is the link a verdict came through. ON DELETE SET NULL: the
    client's sign-off must outlive the link that was revoked, expired or purged.
    `via_link_title` snapshots the link's title at write time so the team can
    still read where it came from.
  * `updated_at` is when the verdict last changed. It starts at `created_at` for
    the rows that exist today, since none of them has changed since.

notifications
  * `actor_name` and `detail` let "Dana (guest) approved X" be a sentence the
    drawer can render. Both stay NULL on every other notification type.

Enums
  * `changes_requested` is added to `approvalstatus` and `shareactivityaction`.
    `activity_logs.action` is a plain string and needs no DDL.
  * `ALTER TYPE ... ADD VALUE` runs in an autocommit block: PostgreSQL does not let
    the surrounding transaction use the new value, and the older releases of it do
    not allow the statement in a transaction block at all.

Downgrade deletes every guest verdict. A guest row cannot satisfy NOT NULL on
`user_id`, and there is no user to hand it to. Enum values cannot be removed from
a PostgreSQL type without rewriting it, so `changes_requested` STAYS in both enums
after a downgrade. A signed-in user's own `changes_requested` verdict survives the
downgrade as `rejected`, which the previous release can read.

Revision ID: a7e3c5d90b42
Revises: f4b9c2a7d105
Create Date: 2026-11-18

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a7e3c5d90b42'
down_revision: Union[str, Sequence[str], None] = 'f4b9c2a7d105'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE approvalstatus ADD VALUE IF NOT EXISTS 'changes_requested'")
        op.execute("ALTER TYPE shareactivityaction ADD VALUE IF NOT EXISTS 'changes_requested'")

    op.alter_column('approvals', 'user_id', existing_type=sa.UUID(), nullable=True)
    op.add_column('approvals', sa.Column('guest_user_id', sa.UUID(), nullable=True))
    op.add_column('approvals', sa.Column('share_link_id', sa.UUID(), nullable=True))
    op.add_column('approvals', sa.Column('via_link_title', sa.String(length=255), nullable=True))
    op.add_column('approvals', sa.Column(
        'updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False,
    ))
    op.execute("UPDATE approvals SET updated_at = created_at")

    op.create_foreign_key(
        'approvals_guest_user_id_fkey', 'approvals', 'guest_users', ['guest_user_id'], ['id'],
    )
    op.create_foreign_key(
        'approvals_share_link_id_fkey', 'approvals', 'share_links', ['share_link_id'], ['id'],
        ondelete='SET NULL',
    )
    op.create_index(op.f('ix_approvals_guest_user_id'), 'approvals', ['guest_user_id'], unique=False)
    op.create_index(op.f('ix_approvals_share_link_id'), 'approvals', ['share_link_id'], unique=False)

    # Every existing row has a user and no guest, so this holds from the first moment.
    op.create_check_constraint(
        'ck_approvals_one_actor', 'approvals', '(user_id IS NOT NULL) <> (guest_user_id IS NOT NULL)',
    )

    op.drop_constraint('uq_approvals_version_user', 'approvals', type_='unique')
    op.create_index(
        'uq_approvals_version_user_live', 'approvals', ['version_id', 'user_id'],
        unique=True, postgresql_where=sa.text('user_id IS NOT NULL'),
    )
    op.create_index(
        'uq_approvals_version_guest', 'approvals', ['version_id', 'guest_user_id'],
        unique=True, postgresql_where=sa.text('guest_user_id IS NOT NULL'),
    )

    op.add_column('notifications', sa.Column('actor_name', sa.String(length=255), nullable=True))
    op.add_column('notifications', sa.Column('detail', sa.String(length=64), nullable=True))


def downgrade() -> None:
    # Deletes every guest verdict: the column that identifies their author is going away
    # and `user_id` goes back to NOT NULL. The ActivityLog entries stay.
    op.execute("DELETE FROM approvals WHERE guest_user_id IS NOT NULL")
    # The previous release's enum has no `changes_requested`, so a surviving row of that status
    # would fail to load there. Map it to `rejected` (not approved); `pending` would read as "no decision".
    op.execute("UPDATE approvals SET status = 'rejected' WHERE status = 'changes_requested'")

    op.drop_column('notifications', 'detail')
    op.drop_column('notifications', 'actor_name')

    op.drop_index('uq_approvals_version_guest', table_name='approvals')
    op.drop_index('uq_approvals_version_user_live', table_name='approvals')
    op.create_unique_constraint('uq_approvals_version_user', 'approvals', ['version_id', 'user_id'])

    op.drop_constraint('ck_approvals_one_actor', 'approvals', type_='check')
    op.drop_index(op.f('ix_approvals_share_link_id'), table_name='approvals')
    op.drop_index(op.f('ix_approvals_guest_user_id'), table_name='approvals')
    op.drop_constraint('approvals_share_link_id_fkey', 'approvals', type_='foreignkey')
    op.drop_constraint('approvals_guest_user_id_fkey', 'approvals', type_='foreignkey')
    op.drop_column('approvals', 'updated_at')
    op.drop_column('approvals', 'via_link_title')
    op.drop_column('approvals', 'share_link_id')
    op.drop_column('approvals', 'guest_user_id')
    op.alter_column('approvals', 'user_id', existing_type=sa.UUID(), nullable=False)

    # The enum values added in upgrade() are NOT removed: PostgreSQL cannot drop a value
    # from a type without rewriting it. `changes_requested` stays in `approvalstatus`
    # and `shareactivityaction`.
