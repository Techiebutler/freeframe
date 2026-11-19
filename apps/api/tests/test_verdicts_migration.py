"""The review-verdicts migration's downgrade, run against a populated database.

Only `downgrade()` is exercised here. `upgrade()` opens an autocommit block for the
`ALTER TYPE ... ADD VALUE` statements, which commits the connection's transaction and
would take the rollback that keeps these tests from touching the shared database with it.
The upgrade half was checked by hand when the migration was written (up, down, up on a
populated database, and the whole chain from an empty one).

Postgres DDL is transactional, so the downgrade below is rolled back with `real_db`
and the database is left at head for every test that follows.

After the downgrade the ORM models no longer match the tables, so everything below
reads and writes through raw SQL and keeps plain ids instead of touching ORM objects.
"""
import importlib.util
import pathlib
import uuid
from types import SimpleNamespace

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from apps.api.models.activity import Notification, NotificationType
from apps.api.models.approval import Approval, ApprovalStatus
from apps.api.models.share import ShareActivityAction, ShareLink, ShareLinkActivity, SharePermission
from apps.api.models.user import GuestUser


def _load_migration():
    path = (pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions"
            / "a7e3c5d90b42_review_verdicts.py")
    spec = importlib.util.spec_from_file_location("review_verdicts_migration", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _downgrade(db):
    mod = _load_migration()
    assert mod.revision == "a7e3c5d90b42" and mod.down_revision == "7c3a9d4b1e2f"
    with Operations.context(MigrationContext.configure(db.connection())):
        mod.downgrade()


def _scalar(db, sql, **params):
    return db.execute(text(sql), params).scalar()


@pytest.fixture
def populated(seed):
    """A version carrying every kind of verdict, a link activity per status, and a
    notification with an actor. Ids only: the ORM objects are unusable after a downgrade."""
    db = seed.db
    a, b, c = seed.user(name="A"), seed.user(name="B"), seed.user(name="C")
    project = seed.project(a)
    asset = seed.asset(project, a)
    version, _ = seed.version(asset, a)
    guest = GuestUser(email=f"mig-{uuid.uuid4()}@client.test", name="Dana")
    db.add(guest)
    db.flush()
    link = ShareLink(token=f"tok-{uuid.uuid4()}", created_by=a.id, asset_id=asset.id,
                     title="Client review", permission=SharePermission.approve)
    db.add(link)
    db.flush()

    def verdict(status, note, **actor):
        row = Approval(asset_id=asset.id, version_id=version.id, status=status, note=note, **actor)
        db.add(row)
        db.flush()
        return row.id

    ids = {
        "asset": asset.id, "version": version.id, "user_a": a.id,
        "legacy_approved": verdict(ApprovalStatus.approved, "legacy", user_id=a.id),
        "user_changes": verdict(ApprovalStatus.changes_requested, "user asks", user_id=b.id),
        "user_rejected": verdict(ApprovalStatus.rejected, "user rejects", user_id=c.id),
        "guest_verdict": verdict(ApprovalStatus.changes_requested, "guest asks", guest_user_id=guest.id,
                                 share_link_id=link.id, via_link_title=link.title),
    }

    def activity(action):
        row = ShareLinkActivity(share_link_id=link.id, action=action, actor_email="dana@client.test",
                                actor_name="Dana")
        db.add(row)
        db.flush()
        return row.id

    ids["activity_changes"] = activity(ShareActivityAction.changes_requested)
    ids["activity_approved"] = activity(ShareActivityAction.approved)
    ids["activity_rejected"] = activity(ShareActivityAction.rejected)

    note = Notification(user_id=a.id, type=NotificationType.approval, asset_id=asset.id,
                        actor_name="Dana", detail="changes_requested")
    db.add(note)
    db.flush()
    ids["notification"] = note.id
    return SimpleNamespace(db=db, **ids)


def _status(db, approval_id):
    return _scalar(db, "SELECT status::text FROM approvals WHERE id = :i", i=approval_id)


def test_downgrade_drops_guest_verdicts_and_keeps_user_verdicts(populated):
    db = populated.db
    _downgrade(db)

    assert _scalar(db, "SELECT count(*) FROM approvals WHERE id = :i", i=populated.guest_verdict) == 0
    for kept in ("legacy_approved", "user_changes", "user_rejected"):
        assert _scalar(db, "SELECT count(*) FROM approvals WHERE id = :i", i=getattr(populated, kept)) == 1, kept


def test_downgrade_maps_a_users_changes_requested_verdict_to_rejected(populated):
    db = populated.db
    _downgrade(db)

    assert _status(db, populated.user_changes) == "rejected"
    assert _status(db, populated.legacy_approved) == "approved"
    assert _status(db, populated.user_rejected) == "rejected"
    # Nothing the previous release's enum lacks is left in the table.
    assert set(db.execute(text("SELECT DISTINCT status::text FROM approvals")).scalars()) <= {
        "approved", "rejected", "pending",
    }


def test_downgrade_maps_changes_requested_link_activity_to_rejected(populated):
    # `ShareLinkActivity.action` is Enum(ShareActivityAction) and GET /share/{token}/activity
    # loads every row. The previous release's enum has no `changes_requested`, so a row
    # holding it would raise LookupError there.
    db = populated.db
    _downgrade(db)

    def action(i):
        return _scalar(db, "SELECT action::text FROM share_link_activity WHERE id = :i", i=i)

    assert action(populated.activity_changes) == "rejected"
    assert action(populated.activity_approved) == "approved"
    assert action(populated.activity_rejected) == "rejected"
    assert set(db.execute(text("SELECT DISTINCT action::text FROM share_link_activity")).scalars()) <= {
        "opened", "viewed_asset", "commented", "approved", "rejected", "downloaded",
    }


def test_downgrade_restores_the_old_approvals_shape(populated):
    db = populated.db
    _downgrade(db)

    columns = set(db.execute(text(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'approvals'"
    )).scalars())
    assert columns == {"id", "asset_id", "version_id", "user_id", "status", "note", "created_at", "deleted_at"}
    assert _scalar(db, "SELECT is_nullable FROM information_schema.columns "
                       "WHERE table_name = 'approvals' AND column_name = 'user_id'") == "NO"

    notification_columns = set(db.execute(text(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'notifications'"
    )).scalars())
    assert not notification_columns & {"actor_name", "detail"}
    assert _scalar(db, "SELECT count(*) FROM notifications WHERE id = :i", i=populated.notification) == 1

    # The plain unique constraint is back; the partial indexes and the one-actor check are gone.
    assert _scalar(db, "SELECT contype::text FROM pg_constraint "
                       "WHERE conname = 'uq_approvals_version_user' AND conrelid = 'approvals'::regclass") == "u"
    assert _scalar(db, "SELECT count(*) FROM pg_constraint WHERE conname = 'ck_approvals_one_actor'") == 0
    assert _scalar(db, "SELECT count(*) FROM pg_indexes WHERE tablename = 'approvals' "
                       "AND indexname IN ('uq_approvals_version_user_live', 'uq_approvals_version_guest', "
                       "'ix_approvals_guest_user_id', 'ix_approvals_share_link_id')") == 0


def test_downgraded_table_enforces_the_old_rules(populated):
    db = populated.db
    _downgrade(db)

    def insert(user_id):
        db.execute(text(
            "INSERT INTO approvals (id, asset_id, version_id, user_id, status) "
            "VALUES (:i, :a, :v, :u, 'approved')"
        ), {"i": uuid.uuid4(), "a": populated.asset, "v": populated.version, "u": user_id})

    with pytest.raises(IntegrityError) as dup:
        with db.begin_nested():
            insert(populated.user_a)
    assert "uq_approvals_version_user" in str(dup.value)

    with pytest.raises(IntegrityError) as no_user:
        with db.begin_nested():
            insert(None)
    assert 'null value in column "user_id"' in str(no_user.value)


def test_the_downgrade_stays_inside_the_tests_transaction(populated):
    """The guard for the rest of the suite: DDL here is transactional, so a second
    connection must still see the head schema while this one has downgraded."""
    from apps.api.database import engine

    _downgrade(populated.db)
    assert _scalar(populated.db, "SELECT count(*) FROM information_schema.columns "
                                 "WHERE table_name = 'approvals' AND column_name = 'guest_user_id'") == 0

    with engine.connect() as other:
        seen = set(other.execute(text(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'approvals'"
        )).scalars())
    assert {"guest_user_id", "share_link_id", "via_link_title", "updated_at"} <= seen
