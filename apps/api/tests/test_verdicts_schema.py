"""Schema for review verdicts: guests can hold a verdict, and "changes requested" is a status.

These run against the real Postgres the migrations built (the `real_db` and
`seed` fixtures), because the rules under test live in the database: a CHECK
constraint, two partial unique indexes, an enum and a foreign key's ON DELETE.
A mock session cannot enforce any of them.

Every refusal below asserts the NAME of the constraint that fired. An
IntegrityError alone is not evidence: before this change a verdict with no
user failed on `user_id` NOT NULL, so a bare `pytest.raises(IntegrityError)`
would have passed against the old schema.
"""
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy.exc import IntegrityError

import apps.api.tasks.cleanup_tasks as ct
from apps.api.models.activity import ActivityAction, ActivityLog, Notification, NotificationType
from apps.api.models.approval import Approval, ApprovalStatus
from apps.api.models.share import (
    ShareActivityAction, ShareLink, ShareLinkActivity, SharePermission,
)
from apps.api.models.user import GuestUser


def _guest(db, name="Dana"):
    g = GuestUser(email=f"guest-{uuid.uuid4()}@client.test", name=name)
    db.add(g)
    db.flush()
    return g


def _link(db, owner, asset, title="Client review"):
    link = ShareLink(
        token=f"tok-{uuid.uuid4()}", created_by=owner.id, asset_id=asset.id,
        title=title, permission=SharePermission.approve,
    )
    db.add(link)
    db.flush()
    return link


@pytest.fixture
def world(seed):
    """One owner, one project, one asset with a single ready version."""
    owner = seed.user(name="Owner")
    project = seed.project(owner)
    asset = seed.asset(project, owner)
    version, _ = seed.version(asset, owner)
    return SimpleNamespace(owner=owner, project=project, asset=asset, version=version, db=seed.db)


def _verdict(w, *, user=None, guest=None, status=ApprovalStatus.approved, **extra):
    return Approval(
        asset_id=w.asset.id, version_id=w.version.id,
        user_id=user.id if user else None,
        guest_user_id=guest.id if guest else None,
        status=status, **extra,
    )


def _refused(db, row, constraint):
    """Flushing `row` must fail on exactly `constraint`; the session stays usable."""
    with pytest.raises(IntegrityError) as raised:
        with db.begin_nested():
            db.add(row)
            db.flush()
    assert constraint in str(raised.value), str(raised.value)


def test_a_user_and_a_guest_verdict_coexist_on_one_version(world):
    guest = _guest(world.db)
    world.db.add(_verdict(world, user=world.owner))
    world.db.add(_verdict(world, guest=guest))
    world.db.flush()

    rows = world.db.query(Approval).filter(Approval.version_id == world.version.id).all()
    assert {(r.user_id, r.guest_user_id) for r in rows} == {
        (world.owner.id, None), (None, guest.id),
    }


def test_two_verdicts_by_one_guest_on_one_version_are_refused(world):
    guest = _guest(world.db)
    world.db.add(_verdict(world, guest=guest))
    world.db.flush()

    _refused(world.db, _verdict(world, guest=guest, status=ApprovalStatus.rejected),
             "uq_approvals_version_guest")


def test_two_verdicts_by_one_user_on_one_version_are_still_refused(world):
    world.db.add(_verdict(world, user=world.owner))
    world.db.flush()

    _refused(world.db, _verdict(world, user=world.owner, status=ApprovalStatus.rejected),
             "uq_approvals_version_user_live")


def test_two_different_guests_each_hold_a_verdict_on_one_version(world):
    world.db.add(_verdict(world, guest=_guest(world.db, "Dana")))
    world.db.add(_verdict(world, guest=_guest(world.db, "Ravi")))
    world.db.flush()

    assert world.db.query(Approval).filter(
        Approval.version_id == world.version.id, Approval.guest_user_id.isnot(None),
    ).count() == 2


def test_a_verdict_needs_exactly_one_actor(world):
    guest = _guest(world.db)
    _refused(world.db, _verdict(world), "ck_approvals_one_actor")
    _refused(world.db, _verdict(world, user=world.owner, guest=guest), "ck_approvals_one_actor")


def test_changes_requested_is_a_stored_status(world):
    row = _verdict(world, user=world.owner, status=ApprovalStatus.changes_requested, note="Tighten the cut")
    world.db.add(row)
    world.db.flush()
    world.db.expire(row)

    stored = world.db.query(Approval).filter(Approval.id == row.id).one()
    assert stored.status is ApprovalStatus.changes_requested
    assert stored.status.value == "changes_requested"


def test_pending_is_kept_in_the_enum(world):
    # Dropping a Postgres enum value means rewriting the type, so `pending` stays
    # even though no verdict code produces it.
    row = _verdict(world, user=world.owner, status=ApprovalStatus.pending)
    world.db.add(row)
    world.db.flush()
    world.db.expire(row)
    assert world.db.query(Approval).filter(Approval.id == row.id).one().status is ApprovalStatus.pending


def test_a_verdict_remembers_the_link_it_came_through(world):
    link = _link(world.db, world.owner, world.asset)
    row = _verdict(world, guest=_guest(world.db), share_link_id=link.id, via_link_title=link.title)
    world.db.add(row)
    world.db.flush()
    world.db.expire(row)

    stored = world.db.query(Approval).filter(Approval.id == row.id).one()
    assert (stored.share_link_id, stored.via_link_title) == (link.id, "Client review")


def test_a_verdict_has_an_updated_at_that_moves_when_it_changes(world):
    long_ago = datetime(2020, 1, 1, tzinfo=timezone.utc)
    row = _verdict(world, user=world.owner, updated_at=long_ago)
    world.db.add(row)
    world.db.flush()
    assert world.db.query(Approval.updated_at).filter(Approval.id == row.id).scalar() == long_ago

    row.status = ApprovalStatus.rejected
    world.db.flush()
    world.db.expire(row)
    assert row.updated_at > long_ago + timedelta(days=365)


def test_a_verdict_written_without_updated_at_gets_one(world):
    row = _verdict(world, user=world.owner)
    world.db.add(row)
    world.db.flush()
    world.db.expire(row)
    assert row.updated_at is not None


def test_deleting_a_link_row_unlinks_its_verdicts_in_the_database(world):
    # The ON DELETE SET NULL itself, with the purge code out of the picture.
    link = _link(world.db, world.owner, world.asset)
    row = _verdict(world, guest=_guest(world.db), share_link_id=link.id, via_link_title=link.title)
    world.db.add(row)
    world.db.flush()

    world.db.query(ShareLink).filter(ShareLink.id == link.id).delete(synchronize_session=False)
    world.db.flush()
    world.db.expire(row)

    assert row.share_link_id is None
    assert row.via_link_title == "Client review"


def test_purging_a_link_keeps_its_verdicts(world):
    link = _link(world.db, world.owner, world.asset)
    link_id = link.id
    row = _verdict(world, guest=_guest(world.db), share_link_id=link_id, via_link_title="Client review")
    world.db.add(row)
    world.db.flush()

    ct._purge_share_link(world.db, link_id, ct.PurgeCounts())
    world.db.expire_all()

    assert world.db.query(ShareLink).filter(ShareLink.id == link_id).first() is None
    kept = world.db.query(Approval).filter(Approval.id == row.id).one()
    assert kept.share_link_id is None
    assert kept.via_link_title == "Client review"


def test_purging_a_link_leaves_other_links_verdicts_alone(world):
    mine = _link(world.db, world.owner, world.asset, title="Mine")
    other = _link(world.db, world.owner, world.asset, title="Other")
    keep = _verdict(world, guest=_guest(world.db), share_link_id=other.id, via_link_title="Other")
    world.db.add(keep)
    world.db.flush()

    ct._purge_share_link(world.db, mine.id, ct.PurgeCounts())
    world.db.expire_all()

    assert world.db.query(Approval).filter(Approval.id == keep.id).one().share_link_id == other.id


def test_a_share_activity_can_record_changes_requested(world):
    link = _link(world.db, world.owner, world.asset)
    entry = ShareLinkActivity(
        share_link_id=link.id, action=ShareActivityAction.changes_requested,
        actor_email="dana@client.test", actor_name="Dana",
    )
    world.db.add(entry)
    world.db.flush()
    world.db.expire(entry)
    assert world.db.query(ShareLinkActivity).filter(ShareLinkActivity.id == entry.id).one().action \
        is ShareActivityAction.changes_requested


def test_the_activity_log_has_verdict_actions():
    # ActivityLog.action is a plain string column, so these are names, not DDL.
    assert ActivityAction.changes_requested.value == "changes_requested"
    assert ActivityAction.verdict_removed.value == "verdict_removed"
    assert ActivityAction.verdict_cleared.value == "verdict_cleared"


def test_a_notification_can_name_who_acted_and_what_they_did(world):
    note = Notification(
        user_id=world.owner.id, type=NotificationType.approval, asset_id=world.asset.id,
        actor_name="Dana", detail="approved",
    )
    world.db.add(note)
    world.db.flush()
    world.db.expire(note)

    stored = world.db.query(Notification).filter(Notification.id == note.id).one()
    assert (stored.actor_name, stored.detail) == ("Dana", "approved")


def test_a_notification_without_an_actor_is_still_valid(world):
    note = Notification(user_id=world.owner.id, type=NotificationType.comment, asset_id=world.asset.id)
    world.db.add(note)
    world.db.flush()
    world.db.expire(note)
    stored = world.db.query(Notification).filter(Notification.id == note.id).one()
    assert (stored.actor_name, stored.detail) == (None, None)


def test_an_activity_log_row_accepts_the_new_actions(world):
    row = ActivityLog(
        project_id=world.project.id, asset_id=world.asset.id, user_id=world.owner.id,
        action=ActivityAction.verdict_removed.value, payload={},
    )
    world.db.add(row)
    world.db.flush()
    assert row.id is not None
