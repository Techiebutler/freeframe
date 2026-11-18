"""The verdict service: the one place every verdict write goes through.

Real Postgres, through the real app where a route is involved. `db` is a session
whose commits land in a SAVEPOINT, so the service can commit (it must: Task 4
relies on its single commit to persist the ShareLinkActivity row it added) and
the outer transaction still rolls back.

Postgres `now()` is fixed for a whole transaction, so every row written in one
test shares `created_at` and `updated_at`. Listings are therefore compared as
sets, never as sequences.
"""
import json
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy import event

from apps.api.tests.test_share_links_trashed_content import (  # noqa: F401  (fixtures)
    _auth, _seed, client, db,
)

from apps.api.models.activity import ActivityLog, Notification, NotificationType
from apps.api.models.approval import Approval, ApprovalStatus
from apps.api.models.asset import AssetVersion, ProcessingStatus
from apps.api.models.project import ProjectMember, ProjectRole
from apps.api.models.share import ShareLink, SharePermission
from apps.api.models.user import GuestUser
from apps.api.services import event_service
from apps.api.services.verdicts import (
    Actor, clear_verdict, list_verdicts, remove_verdict, set_verdict, verdict_summaries,
)
from apps.api.tasks.email_tasks import send_approval_email


@pytest.fixture(autouse=True)
def _no_broker(monkeypatch):
    """No test may reach a Celery broker or Redis; `mocks` replaces these to assert on them."""
    monkeypatch.setattr("apps.api.services.verdicts.send_task_safe", MagicMock())
    monkeypatch.setattr(event_service, "publish_sync", MagicMock(return_value=True))


@pytest.fixture
def mocks(db, monkeypatch):
    """The two outbound side effects, recorded. Request this AFTER `client`, which
    replaces `publish_sync` with a lambda of its own."""
    send, publish = MagicMock(), MagicMock(return_value=True)
    monkeypatch.setattr("apps.api.services.verdicts.send_task_safe", send)
    monkeypatch.setattr(event_service, "publish_sync", publish)
    return SimpleNamespace(send=send, publish=publish)


def _guest(db, name="Dana"):
    g = GuestUser(email=f"{name.lower()[:20]}-{uuid.uuid4().hex[:8]}@client.test", name=name)
    db.add(g)
    db.flush()
    return g


def _link(db, w, title="Client review", asset=None):
    row = ShareLink(token=f"approve-{uuid.uuid4().hex}", created_by=w.owner.id,
                    asset_id=(asset or w.A).id, title=title, permission=SharePermission.approve)
    db.add(row)
    db.flush()
    return row


def _rows(db, version):
    return db.query(Approval).filter(Approval.version_id == version.id).all()


def _names(listing):
    return {v.who.name for v in listing}


def _v1(w, asset=None):
    return w.versions[(asset or w.A).id]


# ── upsert ────────────────────────────────────────────────────────────────────

def test_set_then_change_keeps_one_row_and_updates_status(db):
    w = _seed(db)
    v = _v1(w)
    actor = Actor(user=w.editor)

    first = set_verdict(db, w.A, v, actor, "approved", "looks good")
    second = set_verdict(db, w.A, v, actor, "changes_requested", "fix the audio")

    [row] = _rows(db, v)
    assert row.id == first.id == second.id
    assert row.status == ApprovalStatus.changes_requested
    assert row.note == "fix the audio"
    assert row.user_id == w.editor.id and row.guest_user_id is None
    assert row.asset_id == w.A.id


def test_a_guest_changing_their_verdict_keeps_one_row(db):
    """The guest partial index has its own predicate; the upsert must match it."""
    w = _seed(db)
    v = _v1(w)
    guest = _guest(db)
    actor = Actor(guest=guest, share_link=_link(db, w))

    set_verdict(db, w.A, v, actor, "approved", None)
    set_verdict(db, w.A, v, actor, "rejected", "no")

    [row] = _rows(db, v)
    assert row.guest_user_id == guest.id and row.user_id is None
    assert row.status == ApprovalStatus.rejected and row.note == "no"


def test_a_user_and_a_guest_on_the_same_version_get_separate_rows(db):
    w = _seed(db)
    v = _v1(w)
    set_verdict(db, w.A, v, Actor(user=w.editor), "approved", None)
    set_verdict(db, w.A, v, Actor(guest=_guest(db)), "approved", None)
    assert len(_rows(db, v)) == 2


def test_the_link_is_recorded_on_every_write(db):
    w = _seed(db)
    v = _v1(w)
    link = _link(db, w, title="Client review")

    set_verdict(db, w.A, v, Actor(user=w.direct, share_link=link), "approved", None)
    [row] = _rows(db, v)
    assert row.share_link_id == link.id and row.via_link_title == "Client review"

    # The same person, now acting from the project rather than a link: no stale origin.
    set_verdict(db, w.A, v, Actor(user=w.direct), "rejected", None)
    db.refresh(row)
    assert row.share_link_id is None and row.via_link_title is None


def test_pending_is_never_a_verdict(db):
    w = _seed(db)
    for bad in ("pending", "maybe", ""):
        with pytest.raises(ValueError):
            set_verdict(db, w.A, _v1(w), Actor(user=w.editor), bad, None)
    assert _rows(db, _v1(w)) == []


def test_an_actor_must_be_exactly_one_of_user_or_guest(db):
    w = _seed(db)
    with pytest.raises(ValueError):
        set_verdict(db, w.A, _v1(w), Actor(), "approved", None)
    with pytest.raises(ValueError):
        set_verdict(db, w.A, _v1(w), Actor(user=w.editor, guest=_guest(db)), "approved", None)


def test_the_display_name_is_the_users_or_the_guests(db):
    w = _seed(db)
    assert Actor(user=w.editor).display_name == "editor"
    assert Actor(guest=_guest(db, "Dana")).display_name == "Dana"


# ── clear and remove ──────────────────────────────────────────────────────────

def test_clear_then_set_again_succeeds(db):
    """Review Focus 3. Give, clear, give: the second give must not meet the first row."""
    w = _seed(db)
    v = _v1(w)
    guest = _guest(db)
    for actor in (Actor(user=w.editor), Actor(guest=guest, share_link=_link(db, w))):
        set_verdict(db, w.A, v, actor, "approved", None)
        assert clear_verdict(db, w.A, v, actor) is True
        assert [r for r in _rows(db, v)
                if r.user_id == (actor.user.id if actor.user else None)
                and r.guest_user_id == (actor.guest.id if actor.guest else None)] == []

        again = set_verdict(db, w.A, v, actor, "rejected", "changed my mind")
        assert again.status == ApprovalStatus.rejected
        assert clear_verdict(db, w.A, v, actor) is True

    assert _rows(db, v) == []


def test_clearing_deletes_the_row_rather_than_hiding_it(db):
    w = _seed(db)
    v = _v1(w)
    set_verdict(db, w.A, v, Actor(user=w.editor), "approved", None)
    clear_verdict(db, w.A, v, Actor(user=w.editor))
    assert db.query(Approval).filter(Approval.version_id == v.id).count() == 0


def test_clearing_only_touches_the_callers_own_verdict(db):
    w = _seed(db)
    v = _v1(w)
    set_verdict(db, w.A, v, Actor(user=w.editor), "approved", None)
    set_verdict(db, w.A, v, Actor(user=w.viewer), "approved", None)
    set_verdict(db, w.A, v, Actor(guest=_guest(db)), "approved", None)

    assert clear_verdict(db, w.A, v, Actor(user=w.editor)) is True
    assert len(_rows(db, v)) == 2


def test_clearing_when_there_is_nothing_to_clear_returns_false_but_still_commits_and_publishes(db, mocks):
    """The contract: always log, commit and publish; the return value says whether a row existed.
    The unconditional commit matters to Task 4, which adds a ShareLinkActivity row before calling."""
    from apps.api.models.share import ShareActivityAction, ShareLinkActivity

    w = _seed(db)
    link = _link(db, w)
    commits = []
    original = db.commit
    db.commit = lambda: (commits.append(1), original())[1]
    try:
        db.add(ShareLinkActivity(share_link_id=link.id, action=ShareActivityAction.approved,
                                 actor_email="dana@client.test", actor_name="Dana",
                                 asset_id=w.A.id, asset_name=w.A.name))
        assert clear_verdict(db, w.A, _v1(w), Actor(user=w.editor)) is False
    finally:
        db.commit = original

    assert len(commits) == 1
    assert db.query(ShareLinkActivity).filter(ShareLinkActivity.share_link_id == link.id).count() == 1
    assert db.query(Notification).filter(Notification.asset_id == w.A.id).count() == 0
    mocks.send.assert_not_called()
    mocks.publish.assert_called_once_with(w.project.id, "approval_updated", {
        "asset_id": str(w.A.id), "version_id": str(_v1(w).id),
    })
    assert db.query(ActivityLog).filter(
        ActivityLog.asset_id == w.A.id, ActivityLog.action == "verdict_cleared").count() == 1


def test_clear_and_remove_notify_nobody(db, mocks):
    w = _seed(db)
    v = _v1(w)
    guest = _guest(db)
    set_verdict(db, w.A, v, Actor(guest=guest), "approved", None)
    [row] = _rows(db, v)
    assert db.query(Notification).filter(Notification.asset_id == w.A.id).count() == 1
    mocks.send.reset_mock()
    mocks.publish.reset_mock()

    assert clear_verdict(db, w.A, v, Actor(guest=guest)) is True
    mocks.publish.assert_called_once_with(w.project.id, "approval_updated", {
        "asset_id": str(w.A.id), "version_id": str(v.id),
    })
    cleared = db.query(ActivityLog).filter(
        ActivityLog.asset_id == w.A.id, ActivityLog.action == "verdict_cleared").one()
    assert cleared.payload["actor_name"] == "Dana" and cleared.payload["guest"] is True

    set_verdict(db, w.A, v, Actor(user=w.viewer), "rejected", None)
    [row] = _rows(db, v)
    mocks.send.reset_mock()
    mocks.publish.reset_mock()
    notifications = db.query(Notification).filter(Notification.asset_id == w.A.id).count()

    remove_verdict(db, w.A, row.id, w.editor)

    assert _rows(db, v) == []
    assert db.query(Notification).filter(Notification.asset_id == w.A.id).count() == notifications
    mocks.send.assert_not_called()
    mocks.publish.assert_called_once_with(w.project.id, "approval_updated", {
        "asset_id": str(w.A.id), "version_id": str(v.id),
    })


def test_removing_a_verdict_is_logged_with_who_and_whose(db):
    w = _seed(db)
    v = _v1(w)
    set_verdict(db, w.A, v, Actor(guest=_guest(db, "Dana")), "rejected", "no")
    [row] = _rows(db, v)

    remove_verdict(db, w.A, row.id, w.editor)

    log = db.query(ActivityLog).filter(
        ActivityLog.asset_id == w.A.id, ActivityLog.action == "verdict_removed").one()
    assert log.user_id == w.editor.id
    assert log.payload == {"removed_actor_name": "Dana", "version_id": str(v.id)}


def test_removing_a_verdict_that_is_not_on_this_asset_is_a_404_and_writes_nothing(db, mocks):
    w = _seed(db)
    other_version = _v1(w, w.AF)
    set_verdict(db, w.AF, other_version, Actor(user=w.editor), "approved", None)
    [elsewhere] = _rows(db, other_version)
    mocks.publish.reset_mock()

    for missing in (uuid.uuid4(), elsewhere.id):
        with pytest.raises(HTTPException) as err:
            remove_verdict(db, w.A, missing, w.owner)
        assert err.value.status_code == 404

    assert len(_rows(db, other_version)) == 1
    assert db.query(ActivityLog).filter(ActivityLog.action == "verdict_removed").count() == 0
    mocks.publish.assert_not_called()


# ── listing ───────────────────────────────────────────────────────────────────

def test_guest_and_user_verdicts_are_listed_with_kinds(db):
    w = _seed(db)
    v = _v1(w)
    link = _link(db, w, title="Client review")
    set_verdict(db, w.A, v, Actor(user=w.editor), "approved", "ship it")
    set_verdict(db, w.A, v, Actor(guest=_guest(db, "Dana"), share_link=link), "rejected", "no")
    set_verdict(db, w.A, v, Actor(user=w.direct, share_link=link), "changes_requested", None)

    listing = {x.who.name: x for x in list_verdicts(db, w.A, v.id, me=Actor(user=w.owner))}

    assert set(listing) == {"editor", "Dana", "direct"}
    assert (listing["editor"].who.kind, listing["editor"].who.is_guest) == ("team", False)
    assert (listing["Dana"].who.kind, listing["Dana"].who.is_guest) == ("external", True)
    # A signed-in account that is not a member is external, but it is not a guest.
    assert (listing["direct"].who.kind, listing["direct"].who.is_guest) == ("external", False)
    assert listing["editor"].status == "approved" and listing["editor"].note == "ship it"
    assert listing["Dana"].via_link_title == "Client review"
    assert listing["editor"].via_link_title is None
    assert not any(x.is_mine for x in listing.values())
    assert all(x.version_id == v.id for x in listing.values())


def test_is_mine_marks_only_the_callers_own_row(db):
    w = _seed(db)
    v = _v1(w)
    dana = _guest(db, "Dana")
    set_verdict(db, w.A, v, Actor(user=w.editor), "approved", None)
    set_verdict(db, w.A, v, Actor(guest=dana), "approved", None)
    set_verdict(db, w.A, v, Actor(guest=_guest(db, "Eli")), "approved", None)

    as_editor = {x.who.name: x.is_mine for x in list_verdicts(db, w.A, v.id, me=Actor(user=w.editor))}
    as_dana = {x.who.name: x.is_mine for x in list_verdicts(db, w.A, v.id, me=Actor(guest=dana))}

    assert as_editor == {"editor": True, "Dana": False, "Eli": False}
    assert as_dana == {"editor": False, "Dana": True, "Eli": False}


def test_guest_scope_hides_team_and_other_links(db):
    w = _seed(db)
    v = _v1(w)
    link_l, link_m = _link(db, w, "L"), _link(db, w, "M")
    me = _guest(db, "Me")
    same_link = _guest(db, "SameLink")
    # A project member who acted on this very link: still team, still hidden.
    set_verdict(db, w.A, v, Actor(user=w.editor, share_link=link_l), "rejected", "team says no")
    set_verdict(db, w.A, v, Actor(guest=same_link, share_link=link_l), "approved", None)
    set_verdict(db, w.A, v, Actor(guest=_guest(db, "OtherLink"), share_link=link_m), "approved", None)
    set_verdict(db, w.A, v, Actor(user=w.direct), "approved", None)  # external, no link at all
    set_verdict(db, w.A, v, Actor(guest=me, share_link=link_l), "changes_requested", None)

    seen = list_verdicts(db, w.A, v.id, me=Actor(guest=me, share_link=link_l),
                         guest_scope_link_id=link_l.id)

    assert _names(seen) == {"Me", "SameLink"}
    assert {x.who.name: x.is_mine for x in seen} == {"Me": True, "SameLink": False}
    # The unscoped listing, which the team gets, holds all five.
    assert len(list_verdicts(db, w.A, v.id, me=Actor(user=w.owner))) == 5


def test_guest_scope_with_no_verdict_of_their_own_still_sees_the_link(db):
    """A guest who has not decided yet must not be treated as 'owning' every row."""
    w = _seed(db)
    v = _v1(w)
    link = _link(db, w)
    set_verdict(db, w.A, v, Actor(user=w.editor), "approved", None)
    set_verdict(db, w.A, v, Actor(guest=_guest(db, "Peer"), share_link=link), "approved", None)

    newcomer = _guest(db, "Newcomer")
    seen = list_verdicts(db, w.A, v.id, me=Actor(guest=newcomer, share_link=link),
                         guest_scope_link_id=link.id)

    assert _names(seen) == {"Peer"}
    assert not any(x.is_mine for x in seen)


def test_a_signed_in_non_member_keeps_their_own_row_in_scope(db):
    w = _seed(db)
    v = _v1(w)
    link = _link(db, w)
    mine = Actor(user=w.direct, share_link=link)
    set_verdict(db, w.A, v, mine, "approved", None)

    seen = list_verdicts(db, w.A, v.id, me=mine, guest_scope_link_id=link.id)

    assert [(x.who.name, x.is_mine) for x in seen] == [("direct", True)]


def test_a_non_member_turns_team_once_added(db):
    """Review Focus 4. A verdict given as external reads as team once its giver is a member."""
    w = _seed(db)
    v = _v1(w)
    link = _link(db, w)
    client_user = w.creator  # has an account, is not on the project
    set_verdict(db, w.A, v, Actor(user=client_user, share_link=link), "approved", "from the client")
    peer = _guest(db, "Peer")

    def kinds():
        return {x.who.name: x.who.kind for x in list_verdicts(db, w.A, v.id, me=Actor(user=w.owner))}

    def guest_sees():
        return _names(list_verdicts(db, w.A, v.id, me=Actor(guest=peer, share_link=link),
                                    guest_scope_link_id=link.id))

    assert kinds() == {"creator": "external"}
    assert guest_sees() == {"creator"}

    member = ProjectMember(project_id=w.project.id, user_id=client_user.id, role=ProjectRole.reviewer)
    db.add(member)
    db.flush()
    assert kinds() == {"creator": "team"}
    assert guest_sees() == set()

    # Membership that has been removed is not membership.
    from datetime import datetime, timezone
    member.deleted_at = datetime.now(timezone.utc)
    db.flush()
    assert kinds() == {"creator": "external"}
    assert guest_sees() == {"creator"}


def test_listing_is_scoped_to_the_asset_and_version(db):
    w = _seed(db)
    v1 = _v1(w)
    v2 = AssetVersion(asset_id=w.A.id, version_number=2, processing_status=ProcessingStatus.ready,
                      created_by=w.owner.id)
    db.add(v2)
    db.flush()
    set_verdict(db, w.A, v1, Actor(user=w.editor), "approved", None)
    set_verdict(db, w.A, v2, Actor(user=w.viewer), "rejected", None)
    set_verdict(db, w.AF, _v1(w, w.AF), Actor(user=w.editor), "approved", None)

    assert _names(list_verdicts(db, w.A, v1.id, me=Actor(user=w.owner))) == {"editor"}
    assert _names(list_verdicts(db, w.A, v2.id, me=Actor(user=w.owner))) == {"viewer"}
    # A version that belongs to a different asset yields nothing for this one.
    assert list_verdicts(db, w.A, _v1(w, w.AF).id, me=Actor(user=w.owner)) == []


def test_listing_never_returns_emails(db):
    w = _seed(db)
    v = _v1(w)
    link = _link(db, w)
    set_verdict(db, w.A, v, Actor(user=w.editor), "approved", "ship it")
    set_verdict(db, w.A, v, Actor(guest=_guest(db, "Dana"), share_link=link), "rejected", "no")
    set_verdict(db, w.A, v, Actor(user=w.direct, share_link=link), "changes_requested", None)

    for me, scope in ((Actor(user=w.owner), None),
                      (Actor(guest=_guest(db, "Eli"), share_link=link), link.id)):
        listing = list_verdicts(db, w.A, v.id, me=me, guest_scope_link_id=scope)
        assert listing
        assert "@" not in json.dumps([x.model_dump(mode="json") for x in listing])


def test_an_avatar_is_signed_not_leaked_as_a_raw_key(db, monkeypatch):
    w = _seed(db)
    v = _v1(w)
    w.editor.avatar_url = f"avatars/{w.editor.id}/me.png"
    w.editor.avatar_color = "#112233"
    w.viewer.avatar_url = "https://elsewhere.test/not-ours.png"  # not the user's own key
    db.flush()
    monkeypatch.setattr("apps.api.services.s3_service.generate_presigned_get_url",
                        lambda key: f"https://signed.test/{key}")
    set_verdict(db, w.A, v, Actor(user=w.editor), "approved", None)
    set_verdict(db, w.A, v, Actor(user=w.viewer), "approved", None)
    set_verdict(db, w.A, v, Actor(guest=_guest(db, "Dana")), "approved", None)

    who = {x.who.name: x.who for x in list_verdicts(db, w.A, v.id, me=Actor(user=w.owner))}

    assert who["editor"].avatar_url == f"https://signed.test/avatars/{w.editor.id}/me.png"
    assert who["editor"].avatar_color == "#112233"
    assert who["viewer"].avatar_url is None
    assert who["Dana"].avatar_url is None and who["Dana"].avatar_color is None


def test_a_legacy_pending_row_is_not_a_verdict(db):
    w = _seed(db)
    v = _v1(w)
    db.add(Approval(asset_id=w.A.id, version_id=v.id, user_id=w.viewer.id,
                    status=ApprovalStatus.pending))
    db.flush()
    set_verdict(db, w.A, v, Actor(user=w.editor), "approved", None)

    assert _names(list_verdicts(db, w.A, v.id, me=Actor(user=w.owner))) == {"editor"}
    assert verdict_summaries(db, [v.id])[v.id].model_dump() == {
        "approved": 1, "changes_requested": 0, "rejected": 0}


# ── summaries ─────────────────────────────────────────────────────────────────

def test_summaries_count_per_version(db):
    w = _seed(db)
    v1 = _v1(w)
    v2 = AssetVersion(asset_id=w.A.id, version_number=2, processing_status=ProcessingStatus.ready,
                      created_by=w.owner.id)
    db.add(v2)
    db.flush()
    untouched = _v1(w, w.AF)
    set_verdict(db, w.A, v1, Actor(user=w.editor), "approved", None)
    set_verdict(db, w.A, v1, Actor(guest=_guest(db, "Dana")), "approved", None)
    set_verdict(db, w.A, v1, Actor(user=w.viewer), "rejected", None)
    set_verdict(db, w.A, v2, Actor(user=w.editor), "changes_requested", None)

    wanted = [v1.id, v2.id, untouched.id]  # read now: an expired row would query lazily
    statements = []
    engine = db.get_bind()

    def _count(conn, cursor, statement, *a):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", _count)
    try:
        summaries = verdict_summaries(db, wanted)
    finally:
        event.remove(engine, "before_cursor_execute", _count)

    assert len(statements) == 1, statements
    assert summaries[v1.id].model_dump() == {"approved": 2, "changes_requested": 0, "rejected": 1}
    assert summaries[v2.id].model_dump() == {"approved": 0, "changes_requested": 1, "rejected": 0}
    # A version nobody has judged is present, not missing, so a caller can index it.
    assert summaries[untouched.id].model_dump() == {"approved": 0, "changes_requested": 0, "rejected": 0}


def test_summaries_of_nothing_is_empty_and_runs_no_query(db):
    assert verdict_summaries(db, []) == {}


# ── notifications, email, events ──────────────────────────────────────────────

def test_creator_is_notified_with_actor_and_detail(db, client, mocks):
    w = _seed(db)
    v = _v1(w)
    assert w.A.created_by == w.owner.id
    dana = _guest(db, "Dana")

    set_verdict(db, w.A, v, Actor(guest=dana, share_link=_link(db, w)), "approved", "love it")

    [n] = db.query(Notification).filter(Notification.asset_id == w.A.id).all()
    assert n.user_id == w.owner.id and n.type == NotificationType.approval
    assert n.actor_name == "Dana (guest)" and n.detail == "approved"

    mocks.send.assert_called_once()
    args, kwargs = mocks.send.call_args
    assert args == (send_approval_email,)
    assert kwargs["to_email"] == w.owner.email
    assert kwargs["reviewer_name"] == "Dana"
    assert kwargs["status"] == "approved" and kwargs["note"] == "love it"
    assert kwargs["asset_name"] == w.A.name
    assert str(w.A.id) in kwargs["asset_link"]

    mocks.publish.assert_called_once_with(w.project.id, "approval_updated", {
        "asset_id": str(w.A.id), "version_id": str(v.id), "status": "approved",
    })

    r = client.get("/me/notifications", headers=_auth(w.owner))
    assert r.status_code == 200, r.text
    [shown] = [x for x in r.json() if x["asset_id"] == str(w.A.id)]
    assert shown["type"] == "approval"
    assert shown["actor_name"] == "Dana (guest)"
    assert shown["detail"] == "approved"


def test_a_team_member_is_named_without_the_guest_suffix(db, client, mocks):
    w = _seed(db)
    set_verdict(db, w.A, _v1(w), Actor(user=w.editor), "changes_requested", "tighten the cut")

    [n] = db.query(Notification).filter(Notification.asset_id == w.A.id).all()
    assert (n.actor_name, n.detail) == ("editor", "changes_requested")
    assert mocks.send.call_args.kwargs["status"] == "changes_requested"
    assert mocks.send.call_args.kwargs["reviewer_name"] == "editor"

    r = client.get("/me/notifications", headers=_auth(w.owner))
    [shown] = [x for x in r.json() if x["asset_id"] == str(w.A.id)]
    assert (shown["actor_name"], shown["detail"]) == ("editor", "changes_requested")


def test_a_long_guest_name_still_fits_the_notification_column(db):
    w = _seed(db)
    long_name = "D" * 255  # GuestUser.name allows 255
    set_verdict(db, w.A, _v1(w), Actor(guest=_guest(db, long_name)), "approved", None)

    [n] = db.query(Notification).filter(Notification.asset_id == w.A.id).all()
    assert len(n.actor_name) <= 255 and n.actor_name.endswith(" (guest)")


def test_changing_a_verdict_notifies_again(db, mocks):
    w = _seed(db)
    v = _v1(w)
    set_verdict(db, w.A, v, Actor(user=w.editor), "approved", None)
    set_verdict(db, w.A, v, Actor(user=w.editor), "rejected", None)

    notes = db.query(Notification).filter(Notification.asset_id == w.A.id).all()
    assert sorted(n.detail for n in notes) == ["approved", "rejected"]
    assert mocks.send.call_count == 2 and mocks.publish.call_count == 2


def test_no_notification_when_actor_is_creator(db, mocks):
    w = _seed(db)
    v = _v1(w)
    assert w.A.created_by == w.owner.id

    set_verdict(db, w.A, v, Actor(user=w.owner), "approved", None)

    assert db.query(Notification).filter(Notification.asset_id == w.A.id).count() == 0
    mocks.send.assert_not_called()
    # Everyone else watching the asset still needs to see it change.
    mocks.publish.assert_called_once()
    assert db.query(ActivityLog).filter(ActivityLog.asset_id == w.A.id).count() == 1


def test_the_verdict_is_written_to_the_activity_log(db):
    w = _seed(db)
    v = _v1(w)
    link = _link(db, w, "Client review")

    set_verdict(db, w.A, v, Actor(user=w.editor), "changes_requested", None)
    set_verdict(db, w.A, v, Actor(guest=_guest(db, "Dana"), share_link=link), "approved", None)

    by_actor = {
        log.payload["actor_name"]: log
        for log in db.query(ActivityLog).filter(ActivityLog.asset_id == w.A.id).all()
    }
    team, guest = by_actor["editor"], by_actor["Dana"]
    assert team.action == "changes_requested" and team.user_id == w.editor.id
    assert team.project_id == w.project.id
    assert team.payload == {"version_id": str(v.id), "actor_name": "editor",
                            "guest": False, "via_link": None}
    assert guest.action == "approved" and guest.user_id is None
    assert guest.payload == {"version_id": str(v.id), "actor_name": "Dana",
                             "guest": True, "via_link": "Client review"}


def test_one_commit_persists_what_the_caller_added_to_the_session(db):
    """Task 4 adds a ShareLinkActivity row, then calls set_verdict and relies on its commit."""
    from apps.api.models.share import ShareActivityAction, ShareLinkActivity

    w = _seed(db)
    link = _link(db, w)
    commits = []
    original = db.commit
    db.commit = lambda: (commits.append(1), original())[1]
    try:
        db.add(ShareLinkActivity(share_link_id=link.id, action=ShareActivityAction.approved,
                                 actor_email="dana@client.test", actor_name="Dana",
                                 asset_id=w.A.id, asset_name=w.A.name))
        set_verdict(db, w.A, _v1(w), Actor(guest=_guest(db, "Dana"), share_link=link), "approved", None)
    finally:
        db.commit = original

    assert len(commits) == 1
    assert db.query(ShareLinkActivity).filter(ShareLinkActivity.share_link_id == link.id).count() == 1


# ── email wording ─────────────────────────────────────────────────────────────

def _send_email_with(monkeypatch, **overrides):
    from apps.api.tasks import email_tasks

    sent = []
    monkeypatch.setattr(email_tasks, "_send_email",
                        lambda to, subject, html, text=None: sent.append((subject, html, text)) or True)
    monkeypatch.setattr(email_tasks, "resolve_org_name", lambda: "Acme")
    kwargs = dict(to_email="owner@t.local", reviewer_name="Dana", asset_name="Cut.mov",
                  status="approved", asset_link="https://x.test/assets/1", note=None)
    kwargs.update(overrides)
    email_tasks.send_approval_email.run(**kwargs)
    [(subject, html, text)] = sent
    return subject, html, text


def test_the_changes_needed_email_says_so(monkeypatch):
    subject, html, text = _send_email_with(monkeypatch, status="changes_requested", note="fix audio")

    assert subject == "✏️ Changes needed on Cut.mov"
    assert "asked for changes" in html and "fix audio" in html
    assert "changes_requested" not in html
    assert "Dana asked for changes on Cut.mov" in text and "changes_requested" not in text


def test_the_approved_and_rejected_emails_read_as_before(monkeypatch):
    subject, html, text = _send_email_with(monkeypatch, status="approved")
    assert subject == "✅ Cut.mov has been approved"
    assert "has been approved" in html and text.startswith("Dana approved Cut.mov.")

    subject, html, text = _send_email_with(monkeypatch, status="rejected")
    assert subject == "❌ Cut.mov has been rejected"
    assert "has been rejected" in html and text.startswith("Dana rejected Cut.mov.")
