"""The share-link verdict routes: PUT/DELETE /share/{token}/verdict and
GET /share/{token}/verdicts.

These let people without an account write data, so most of what is pinned here is
a refusal: the link must allow approvals, the asset must be inside the link's
scope, the version must be one the link shows, a password link needs its session,
trashed content is gone, a project member is held to their role, and a request
that carried a sign-in that no longer works is not quietly filed under a guest.

Real Postgres through the real app, on the share-link world from
`test_share_links_trashed_content`. `db` is a session whose commits land in a
SAVEPOINT, so the service can commit and the outer transaction still rolls back.
Share sessions live in Redis, which the suite does not run, so the password test
stands in for `verify_share_session`.
"""
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import jwt
import pytest

from apps.api.tests.test_share_links_trashed_content import (  # noqa: F401  (fixtures)
    _auth, _seed, client, db,
)

from apps.api.config import settings
from apps.api.models.activity import Notification, NotificationType
from apps.api.models.approval import Approval
from apps.api.models.asset import AssetVersion, ProcessingStatus
from apps.api.models.project import ProjectMember, ProjectRole
from apps.api.models.share import ShareActivityAction, ShareLinkActivity, SharePermission
from apps.api.models.user import GuestUser, User
from apps.api.services import event_service

GUEST = {"guest_name": "Dana", "guest_email": "Dana.Client@Example.test"}
STALE_SIGN_IN = (401, {"detail": "Your sign-in has expired. Sign in again or continue as a guest."})
NO_APPROVALS = (403, {"detail": "This share link does not allow approvals"})
ASSET_NOT_FOUND = (404, {"detail": "Asset not found"})
VERSION_NOT_FOUND = (404, {"detail": "Version not found"})


@pytest.fixture(autouse=True)
def mocks(client, monkeypatch):
    """The two outbound side effects, recorded. Requests `client` first: it replaces
    `publish_sync` with a lambda of its own, and this must win."""
    send, publish = MagicMock(), MagicMock(return_value=True)
    monkeypatch.setattr("apps.api.services.verdicts.send_task_safe", send)
    monkeypatch.setattr(event_service, "publish_sync", publish)
    return SimpleNamespace(send=send, publish=publish)


def _world(db):
    """The share-link world plus a reviewer member, with every link allowing approvals
    and showing every version."""
    w = _seed(db)
    w.reviewer = User(email=f"reviewer-{uuid.uuid4().hex[:8]}@t.local", name="reviewer")
    db.add(w.reviewer)
    db.flush()
    db.add(ProjectMember(project_id=w.project.id, user_id=w.reviewer.id, role=ProjectRole.reviewer))
    for link in w.links.values():
        link.permission = SharePermission.approve
        link.show_versions = True
    db.flush()
    return w


def _v(w, asset=None):
    return w.versions[(asset or w.A).id]


def _put(client, link, version, status="approved", *, asset=None, headers=None, session=None, **extra):
    body = {"version_id": str(version.id), "status": status, **extra}
    if asset is not None:
        body["asset_id"] = str(asset.id)
    params = {"share_session": session} if session else None
    r = client.put(f"/share/{link.token}/verdict", json=body, params=params, headers=headers or {})
    _no_email(r)
    return r


def _query(version, asset, guest_email, session):
    params = {"version_id": str(version.id)}
    if asset is not None:
        params["asset_id"] = str(asset.id)
    if guest_email is not None:
        params["guest_email"] = guest_email
    if session is not None:
        params["share_session"] = session
    return params


def _clear(client, link, version, *, asset=None, guest_email=None, headers=None, session=None):
    return client.delete(f"/share/{link.token}/verdict",
                         params=_query(version, asset, guest_email, session), headers=headers or {})


def _list(client, link, version, *, asset=None, guest_email=None, headers=None, session=None):
    r = client.get(f"/share/{link.token}/verdicts",
                   params=_query(version, asset, guest_email, session), headers=headers or {})
    _no_email(r)
    return r


def _rows(db, asset=None):
    q = db.query(Approval)
    if asset is not None:
        q = q.filter(Approval.asset_id == asset.id)
    return q.all()


def _guests(db, email):
    return db.query(GuestUser).filter(GuestUser.email == email.lower()).all()


def _activity(db, link):
    return db.query(ShareLinkActivity).filter(
        ShareLinkActivity.share_link_id == link.id).order_by(ShareLinkActivity.created_at).all()


def _status(r):
    return r.status_code, r.json()


def _no_email(r):
    """Verdict endpoints never return an email; guests and viewers read them."""
    assert "@" not in r.text, r.text


def _expired_token(user):
    return jwt.encode(
        {"sub": str(user.id), "type": "access", "ver": user.token_version or 1,
         "exp": datetime.now(timezone.utc) - timedelta(minutes=5)},
        settings.jwt_secret, algorithm=settings.jwt_algorithm,
    )


# ── the link has to allow approvals ───────────────────────────────────────────

@pytest.mark.parametrize("permission", [SharePermission.view, SharePermission.comment])
def test_view_and_comment_links_refuse_verdicts(client, db, permission):
    w = _world(db)
    link = w.links["asset"]
    link.permission = permission
    db.flush()

    assert _status(_put(client, link, _v(w), **GUEST)) == NO_APPROVALS
    assert _status(_put(client, link, _v(w), headers=_auth(w.reviewer))) == NO_APPROVALS
    assert _status(_clear(client, link, _v(w), guest_email=GUEST["guest_email"])) == NO_APPROVALS
    assert _status(_list(client, link, _v(w))) == NO_APPROVALS
    assert _rows(db) == []
    assert _guests(db, GUEST["guest_email"]) == []


# ── a guest on an approve link ────────────────────────────────────────────────

def test_a_guest_gives_changes_and_clears_a_verdict_on_an_approve_link(client, db, mocks):
    w = _world(db)
    link, version = w.links["asset"], _v(w)

    r = _put(client, link, version, "approved", **GUEST)
    assert r.status_code == 200, r.text
    _no_email(r)
    given = r.json()
    assert given["status"] == "approved"
    assert given["who"] == {"kind": "external", "name": "Dana", "avatar_url": None,
                            "avatar_color": None, "is_guest": True}
    assert given["is_mine"] is True
    assert given["via_link_title"] == "asset"

    [guest] = _guests(db, GUEST["guest_email"])
    assert guest.email == "dana.client@example.test"
    [row] = _rows(db)
    assert (row.user_id, row.guest_user_id, row.share_link_id, row.version_id) == (
        None, guest.id, link.id, version.id)

    # Changing it keeps one row and one guest, whatever case the email is typed in.
    r = _put(client, link, version, "changes_requested", note="  warmer grade please  ",
             guest_name="Dana", guest_email="dana.client@example.TEST")
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["note"], r.json()["id"]) == (
        "changes_requested", "warmer grade please", given["id"])
    assert len(_rows(db)) == 1
    assert len(_guests(db, GUEST["guest_email"])) == 1

    # Giving and changing each notify the asset's creator once.
    notes = db.query(Notification).filter(Notification.asset_id == w.A.id,
                                          Notification.type == NotificationType.approval).all()
    assert [(n.user_id, n.actor_name, n.detail) for n in notes] == [
        (w.owner.id, "Dana (guest)", "approved"), (w.owner.id, "Dana (guest)", "changes_requested")]
    assert mocks.send.call_count == 2

    r = _list(client, link, version, guest_email="DANA.client@example.test")
    assert r.status_code == 200, r.text
    _no_email(r)
    assert [(v["status"], v["is_mine"]) for v in r.json()] == [("changes_requested", True)]

    r = _clear(client, link, version, guest_email="DANA.CLIENT@example.test")
    assert r.status_code == 204, r.text
    assert _rows(db) == []
    # Clearing nothing is still a 204.
    assert _clear(client, link, version, guest_email=GUEST["guest_email"]).status_code == 204
    # Clearing notifies nobody.
    assert mocks.send.call_count == 2

    # And the guest can decide again after clearing.
    r = _put(client, link, version, "rejected", **GUEST)
    assert r.status_code == 200, r.text
    assert [row.status.value for row in _rows(db)] == ["rejected"]


def test_a_guest_needs_both_identity_fields_and_an_unknown_one_creates_nobody(client, db):
    w = _world(db)
    link, version = w.links["asset"], _v(w)
    required = (400, {"detail": "guest_email and guest_name required"})

    assert _status(_put(client, link, version)) == required
    assert _status(_put(client, link, version, guest_name="Dana")) == required
    assert _status(_put(client, link, version, guest_email="dana@example.test")) == required
    assert _status(_put(client, link, version, guest_name="  ", guest_email="dana@example.test")) == required
    assert _rows(db) == []
    assert _guests(db, "dana@example.test") == []

    # Clearing names whose verdict to clear.
    assert _status(_clear(client, link, version)) == (400, {"detail": "guest_email required"})

    # An email nobody has used is nothing to clear and nothing that is mine, and
    # neither the clear nor the listing makes a guest of it.
    stranger = "nobody-yet@example.test"
    assert _clear(client, link, version, guest_email=stranger).status_code == 204
    r = _list(client, link, version, guest_email=stranger)
    assert (r.status_code, r.json()) == (200, [])
    assert _guests(db, stranger) == []


def test_a_guest_cannot_clear_someone_elses_verdict(client, db):
    w = _world(db)
    link, version = w.links["asset"], _v(w)
    assert _put(client, link, version, **GUEST).status_code == 200
    assert _put(client, link, version, guest_name="Eve", guest_email="eve@example.test").status_code == 200

    assert _clear(client, link, version, guest_email="eve@example.test").status_code == 204
    [left] = _rows(db)
    assert left.guest_user_id == _guests(db, GUEST["guest_email"])[0].id


# ── signed-in callers ─────────────────────────────────────────────────────────

def test_a_signed_in_viewer_member_is_refused_on_the_share_route(client, db):
    w = _world(db)
    link, version = w.links["asset"], _v(w)
    refused = (403, {"detail": "Your project role can't give verdicts"})

    # Guest fields do not turn a member into a guest.
    assert _status(_put(client, link, version, headers=_auth(w.viewer), **GUEST)) == refused
    assert _status(_clear(client, link, version, headers=_auth(w.viewer))) == refused
    assert _rows(db) == []
    assert _guests(db, GUEST["guest_email"]) == []

    # A viewer may still read what the link shows.
    assert _list(client, link, version, headers=_auth(w.viewer)).status_code == 200


def test_a_signed_in_member_acts_as_themselves_and_reads_as_team(client, db):
    w = _world(db)
    link, version = w.links["asset"], _v(w)

    r = _put(client, link, version, "changes_requested", headers=_auth(w.reviewer), **GUEST)
    assert r.status_code == 200, r.text
    assert (r.json()["who"]["kind"], r.json()["who"]["is_guest"], r.json()["is_mine"]) == ("team", False, True)
    [row] = _rows(db)
    assert (row.user_id, row.guest_user_id, row.share_link_id) == (w.reviewer.id, None, link.id)
    assert _guests(db, GUEST["guest_email"]) == []

    assert _clear(client, link, version, headers=_auth(w.reviewer)).status_code == 204
    assert _rows(db) == []


def test_a_signed_in_non_member_is_stored_as_themselves_and_external(client, db):
    w = _world(db)
    link, version = w.links["asset"], _v(w)

    # `creator` holds an account but is not a member of the project.
    r = _put(client, link, version, "approved", headers=_auth(w.creator), **GUEST)
    assert r.status_code == 200, r.text
    _no_email(r)
    who = r.json()["who"]
    assert (who["kind"], who["name"], who["is_guest"]) == ("external", "creator", False)
    [row] = _rows(db)
    assert (row.user_id, row.guest_user_id, row.share_link_id, row.via_link_title) == (
        w.creator.id, None, link.id, "asset")
    assert _guests(db, GUEST["guest_email"]) == []

    assert _clear(client, link, version, headers=_auth(w.creator)).status_code == 204
    assert _rows(db) == []


# ── a sign-in that no longer works ────────────────────────────────────────────

@pytest.mark.parametrize("token_of", [lambda u: "not-a-jwt", _expired_token], ids=["garbage", "expired"])
def test_a_stale_sign_in_is_refused_rather_than_filed_as_a_guest(client, db, token_of):
    w = _world(db)
    link, version = w.links["asset"], _v(w)
    # An external verdict through this link, for the listing below to find.
    assert _put(client, link, version, headers=_auth(w.creator)).status_code == 200
    stale = {"Authorization": f"Bearer {token_of(w.reviewer)}"}

    assert _status(_put(client, link, version, headers=stale, **GUEST)) == STALE_SIGN_IN
    assert _guests(db, GUEST["guest_email"]) == []
    assert [row.user_id for row in _rows(db)] == [w.creator.id]

    assert _status(_clear(client, link, version, headers=stale,
                          guest_email=GUEST["guest_email"])) == STALE_SIGN_IN

    # Reading stays open, as a guest would see it.
    r = _list(client, link, version, headers=stale)
    assert r.status_code == 200, r.text
    assert [(v["who"]["name"], v["is_mine"]) for v in r.json()] == [("creator", False)]


# ── what the link reaches ─────────────────────────────────────────────────────

def test_a_folder_link_refuses_an_asset_outside_its_folder(client, db, mocks):
    w = _world(db)
    folder = w.links["folder"]

    # A is at the project root, outside F.
    assert _status(_put(client, folder, _v(w, w.A), asset=w.A, **GUEST)) == ASSET_NOT_FOUND
    assert _status(_put(client, folder, _v(w, w.A), asset=w.A, headers=_auth(w.reviewer))) == ASSET_NOT_FOUND
    assert _status(_clear(client, folder, _v(w, w.A), asset=w.A,
                          guest_email=GUEST["guest_email"])) == ASSET_NOT_FOUND
    assert _status(_list(client, folder, _v(w, w.A), asset=w.A)) == ASSET_NOT_FOUND
    assert _rows(db) == []
    assert _guests(db, GUEST["guest_email"]) == []
    assert _activity(db, folder) == []
    mocks.publish.assert_not_called()

    # A version of an asset inside the folder, sent with the outside asset's id,
    # is still refused: the asset is checked, not just the version.
    assert _status(_put(client, folder, _v(w, w.AF), asset=w.A, **GUEST)) == ASSET_NOT_FOUND

    # Inside the folder and its subfolder it works.
    assert _put(client, folder, _v(w, w.AF), asset=w.AF, **GUEST).status_code == 200
    assert _put(client, folder, _v(w, w.AS), asset=w.AS, **GUEST).status_code == 200
    assert {row.asset_id for row in _rows(db)} == {w.AF.id, w.AS.id}


def test_a_folder_link_needs_the_asset_named(client, db):
    w = _world(db)
    r = _put(client, w.links["folder"], _v(w, w.AF), **GUEST)
    assert _status(r) == (400, {"detail": "asset_id is required for folder/project shares"})
    assert _rows(db) == []


def test_an_asset_link_refuses_another_asset_and_defaults_to_its_own(client, db):
    w = _world(db)
    link = w.links["asset"]

    assert _status(_put(client, link, _v(w, w.AF), asset=w.AF, **GUEST)) == ASSET_NOT_FOUND
    # Its own asset named explicitly is fine, as is leaving it out.
    assert _put(client, link, _v(w), asset=w.A, **GUEST).status_code == 200
    assert _put(client, link, _v(w), "rejected", **GUEST).status_code == 200
    assert [row.asset_id for row in _rows(db)] == [w.A.id]


@pytest.mark.parametrize("kind", ["project", "multi"])
def test_project_and_multi_links_take_an_asset_in_scope(client, db, kind):
    w = _world(db)
    link = w.links[kind]
    assert _put(client, link, _v(w, w.AS), asset=w.AS, **GUEST).status_code == 200
    r = _list(client, link, _v(w, w.AS), asset=w.AS, guest_email=GUEST["guest_email"])
    assert [v["is_mine"] for v in r.json()] == [True]


def test_a_multi_link_refuses_an_asset_it_does_not_hold(client, db):
    w = _world(db)
    # The multi link holds A and folder F, not the non-member's root asset.
    other = w.A_creator
    assert _status(_put(client, w.links["multi"], _v(w, other), asset=other, **GUEST)) == ASSET_NOT_FOUND
    assert _rows(db) == []


def test_a_hidden_version_is_refused(client, db):
    w = _world(db)
    link = w.links["asset"]
    v1 = _v(w)
    v2 = AssetVersion(asset_id=w.A.id, version_number=2, processing_status=ProcessingStatus.ready,
                      created_by=w.owner.id)
    v3 = AssetVersion(asset_id=w.A.id, version_number=3, processing_status=ProcessingStatus.processing,
                      created_by=w.owner.id)
    db.add_all([v2, v3])
    db.flush()

    link.show_versions = False
    db.flush()
    assert _status(_put(client, link, v1, **GUEST)) == VERSION_NOT_FOUND
    assert _status(_clear(client, link, v1, guest_email=GUEST["guest_email"])) == VERSION_NOT_FOUND
    assert _status(_list(client, link, v1)) == VERSION_NOT_FOUND
    assert _rows(db) == []
    assert _put(client, link, v2, **GUEST).status_code == 200

    link.show_versions = True
    db.flush()
    assert _put(client, link, v1, **GUEST).status_code == 200
    # Not ready is never shown, nor is another asset's version, nor a made-up one.
    assert _status(_put(client, link, v3, **GUEST)) == VERSION_NOT_FOUND
    assert _status(_put(client, link, _v(w, w.AF), **GUEST)) == VERSION_NOT_FOUND
    assert _status(_put(client, link, SimpleNamespace(id=uuid.uuid4()), **GUEST)) == VERSION_NOT_FOUND
    assert {row.version_id for row in _rows(db)} == {v1.id, v2.id}


def test_a_secure_link_refuses_an_anonymous_caller(client, db):
    w = _world(db)
    link, version = w.links["asset"], _v(w)
    link.visibility = "secure"
    db.flush()
    login_required = (403, {"detail": "Authentication required for this link's visibility setting"})

    assert _status(_put(client, link, version, **GUEST)) == login_required
    assert _status(_clear(client, link, version, guest_email=GUEST["guest_email"])) == login_required
    assert _status(_list(client, link, version)) == login_required
    assert _rows(db) == []
    assert _guests(db, GUEST["guest_email"]) == []
    assert _put(client, link, version, headers=_auth(w.creator)).status_code == 200


def test_a_password_link_needs_a_session(client, db, monkeypatch):
    w = _world(db)
    link, version = w.links["password"], _v(w)
    monkeypatch.setattr("apps.api.services.permissions.verify_share_session",
                        lambda token, session: token == link.token and session == "good-session")
    password_required = (403, {"detail": "Password required"})

    assert _status(_put(client, link, version, **GUEST)) == password_required
    assert _status(_put(client, link, version, session="forged", **GUEST)) == password_required
    assert _status(_clear(client, link, version, guest_email=GUEST["guest_email"])) == password_required
    assert _status(_list(client, link, version)) == password_required
    assert _rows(db) == []

    assert _put(client, link, version, session="good-session", **GUEST).status_code == 200
    r = _list(client, link, version, session="good-session", guest_email=GUEST["guest_email"])
    assert [v["is_mine"] for v in r.json()] == [True]
    assert _clear(client, link, version, session="good-session",
                  guest_email=GUEST["guest_email"]).status_code == 204
    assert _rows(db) == []


def test_a_trashed_asset_answers_not_found(client, db):
    w = _world(db)
    folder = w.links["folder"]
    assert _put(client, folder, _v(w, w.AF), asset=w.AF, **GUEST).status_code == 200
    assert client.delete(f"/assets/{w.AF.id}", headers=_auth(w.editor)).status_code == 204
    db.expire_all()

    assert _status(_put(client, folder, _v(w, w.AF), "rejected", asset=w.AF, **GUEST)) == ASSET_NOT_FOUND
    assert _status(_clear(client, folder, _v(w, w.AF), asset=w.AF,
                          guest_email=GUEST["guest_email"])) == ASSET_NOT_FOUND
    assert _status(_list(client, folder, _v(w, w.AF), asset=w.AF)) == ASSET_NOT_FOUND
    [row] = _rows(db)
    assert row.status.value == "approved"

    # The asset's own link is gone with it, like an unknown token.
    assert client.delete(f"/assets/{w.A.id}", headers=_auth(w.editor)).status_code == 204
    db.expire_all()
    gone = (404, {"detail": "Share link not found"})
    assert _status(_put(client, w.links["asset"], _v(w), **GUEST)) == gone
    assert _status(_list(client, w.links["asset"], _v(w))) == gone


# ── what a guest sees ─────────────────────────────────────────────────────────

def test_guest_listing_hides_team_verdicts(client, db):
    w = _world(db)
    link, other_link, version = w.links["asset"], w.links["project"], _v(w)

    # A team verdict from the asset page, and one from a member on this very link.
    assert client.put(f"/assets/{w.A.id}/verdict", json={"version_id": str(version.id), "status": "rejected"},
                      headers=_auth(w.editor)).status_code == 200
    assert _put(client, link, version, "changes_requested", headers=_auth(w.reviewer)).status_code == 200
    # A guest on another link, then a non-member and our guest on this link.
    assert _put(client, other_link, version, asset=w.A, guest_name="Eve",
                guest_email="eve@example.test").status_code == 200
    assert _put(client, link, version, "approved", headers=_auth(w.creator)).status_code == 200
    assert _put(client, link, version, "approved", **GUEST).status_code == 200
    assert len(_rows(db)) == 5

    r = _list(client, link, version, guest_email=GUEST["guest_email"])
    assert r.status_code == 200, r.text
    _no_email(r)
    assert {(v["who"]["name"], v["who"]["kind"], v["is_mine"]) for v in r.json()} == {
        ("creator", "external", False), ("Dana", "external", True)}

    # Anonymous with no identity: the same external verdicts, none of them mine.
    r = _list(client, link, version)
    _no_email(r)
    assert {(v["who"]["name"], v["is_mine"]) for v in r.json()} == {("creator", False), ("Dana", False)}

    # A member reading through the link sees what the link shows, plus their own.
    r = _list(client, link, version, headers=_auth(w.reviewer))
    _no_email(r)
    assert {(v["who"]["name"], v["is_mine"]) for v in r.json()} == {
        ("creator", False), ("Dana", False), ("reviewer", True)}

    # The other link's guest sees only their own.
    r = _list(client, other_link, version, asset=w.A, guest_email="eve@example.test")
    _no_email(r)
    assert [(v["who"]["name"], v["is_mine"]) for v in r.json()] == [("Eve", True)]


# ── the link's activity ───────────────────────────────────────────────────────

def test_a_share_verdict_records_link_activity(client, db):
    w = _world(db)
    link, version = w.links["asset"], _v(w)

    assert _put(client, link, version, "approved", **GUEST).status_code == 200
    assert _put(client, link, version, "changes_requested", **GUEST).status_code == 200
    assert _put(client, link, version, "rejected", headers=_auth(w.creator)).status_code == 200
    assert _clear(client, link, version, guest_email=GUEST["guest_email"]).status_code == 204
    assert _clear(client, link, version, headers=_auth(w.creator)).status_code == 204

    rows = _activity(db, link)
    assert {(a.action, a.actor_email, a.actor_name, a.asset_id, a.asset_name) for a in rows} == {
        (ShareActivityAction.approved, "dana.client@example.test", "Dana", w.A.id, "A"),
        (ShareActivityAction.changes_requested, "dana.client@example.test", "Dana", w.A.id, "A"),
        (ShareActivityAction.rejected, w.creator.email, "creator", w.A.id, "A"),
    }
    assert len(rows) == 3


def test_pressing_the_same_verdict_again_notifies_and_records_once(client, db, mocks):
    w = _world(db)
    link, version = w.links["asset"], _v(w)

    for _ in range(3):
        r = _put(client, link, version, "approved", note="ship it", **GUEST)
        assert r.status_code == 200, r.text
        assert (r.json()["status"], r.json()["note"]) == ("approved", "ship it")
    # The note is compared as stored: the same words with stray space are no change.
    assert _put(client, link, version, "approved", note="  ship it ", **GUEST).status_code == 200

    notes = db.query(Notification).filter(Notification.asset_id == w.A.id).all()
    assert len(notes) == 1
    assert mocks.send.call_count == 1
    assert [a.action for a in _activity(db, link)] == [ShareActivityAction.approved]

    # A new note on the same verdict is a change, and is told and recorded.
    assert _put(client, link, version, "approved", note="ship it today", **GUEST).status_code == 200
    assert db.query(Notification).filter(Notification.asset_id == w.A.id).count() == 2
    assert mocks.send.call_count == 2
    assert len(_activity(db, link)) == 2


def test_a_refused_verdict_records_no_link_activity(client, db):
    w = _world(db)
    link, version = w.links["asset"], _v(w)
    assert _put(client, link, version, headers=_auth(w.viewer)).status_code == 403
    assert _put(client, link, version).status_code == 400
    assert _activity(db, link) == []
