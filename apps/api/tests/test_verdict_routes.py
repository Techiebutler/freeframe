"""The signed-in verdict routes: PUT/DELETE /assets/{id}/verdict, DELETE
/assets/{id}/verdicts/{verdict_id}, GET /assets/{id}/verdicts, and the legacy
POST /approve and /reject that now wrap the same service.

Real Postgres through the real app. `db` is a session whose commits land in a
SAVEPOINT, so the service can commit and the outer transaction still rolls back.
The routes add no side effects of their own: the notification, the email and the
`approval_updated` event all come from the service, so each is asserted once here
to catch a route that would send them a second time.

Postgres `now()` is fixed for a whole transaction, so rows written in one test
share their timestamps and listings are compared as sets, never as sequences.
"""
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from apps.api.tests.test_share_links_trashed_content import (  # noqa: F401  (fixtures)
    _auth, _seed, _trash_project, client, db,
)

from apps.api.models.activity import ActivityLog, Notification, NotificationType
from apps.api.models.approval import Approval, ApprovalStatus
from apps.api.models.asset import AssetVersion
from apps.api.models.project import ProjectMember, ProjectRole
from apps.api.models.user import GuestUser, User
from apps.api.services import event_service
from apps.api.tasks.email_tasks import send_approval_email


@pytest.fixture(autouse=True)
def mocks(client, monkeypatch):
    """The two outbound side effects, recorded. Requests `client` first: it replaces
    `publish_sync` with a lambda of its own, and this must win."""
    send, publish = MagicMock(), MagicMock(return_value=True)
    monkeypatch.setattr("apps.api.services.verdicts.send_task_safe", send)
    monkeypatch.setattr(event_service, "publish_sync", publish)
    return SimpleNamespace(send=send, publish=publish)


def _world(db):
    """The share-link world plus a reviewer, which it does not have."""
    w = _seed(db)
    w.reviewer = User(email=f"reviewer-{uuid.uuid4().hex[:8]}@t.local", name="reviewer")
    db.add(w.reviewer)
    db.flush()
    db.refresh(w.reviewer)
    db.add(ProjectMember(project_id=w.project.id, user_id=w.reviewer.id, role=ProjectRole.reviewer))
    db.flush()
    return w


def _v(w, asset=None):
    return w.versions[(asset or w.A).id]


def _put(client, w, user, status="approved", *, note=None, asset=None, version=None, **extra):
    asset = asset or w.A
    version = version or _v(w, asset)
    body = {"version_id": str(version.id), "status": status, **extra}
    if note is not None:
        body["note"] = note
    return client.put(f"/assets/{asset.id}/verdict", json=body, headers=_auth(user))


def _clear(client, w, user, *, asset=None, version=None):
    asset = asset or w.A
    version = version or _v(w, asset)
    return client.delete(f"/assets/{asset.id}/verdict", params={"version_id": str(version.id)},
                         headers=_auth(user))


def _list(client, w, user, *, asset=None, version=None):
    asset = asset or w.A
    version = version or _v(w, asset)
    return client.get(f"/assets/{asset.id}/verdicts", params={"version_id": str(version.id)},
                      headers=_auth(user))


def _remove(client, w, user, verdict_id, *, asset=None):
    asset = asset or w.A
    return client.delete(f"/assets/{asset.id}/verdicts/{verdict_id}", headers=_auth(user))


def _rows(db, asset):
    return db.query(Approval).filter(Approval.asset_id == asset.id).all()


def _logs(db, asset, action):
    return db.query(ActivityLog).filter(
        ActivityLog.asset_id == asset.id, ActivityLog.action == action).all()


def _notifications(db, asset):
    return db.query(Notification).filter(
        Notification.asset_id == asset.id, Notification.type == NotificationType.approval).all()


def _guest_verdict(db, w, name="Dana", status=ApprovalStatus.rejected, asset=None):
    """A verdict from a share-link guest, written the way Task 4's route will."""
    asset = asset or w.A
    guest = GuestUser(email=f"{name.lower()}-{uuid.uuid4().hex[:8]}@client.test", name=name)
    db.add(guest)
    db.flush()
    row = Approval(asset_id=asset.id, version_id=_v(w, asset).id, guest_user_id=guest.id,
                   status=status, note="not yet")
    db.add(row)
    db.flush()
    return guest, row


# ── who may give, clear and remove ────────────────────────────────────────────

def test_role_matrix_for_giving_a_verdict(client, db):
    w = _world(db)

    for refused in (w.viewer, w.creator, w.direct):
        r = _put(client, w, refused)
        assert r.status_code == 403, (refused.name, r.text)
    assert _rows(db, w.A) == []

    for user in (w.reviewer, w.editor, w.owner):
        r = _put(client, w, user, "changes_requested")
        assert r.status_code == 200, (user.name, r.text)
        assert r.json()["status"] == "changes_requested"
    assert {row.user_id for row in _rows(db, w.A)} == {w.reviewer.id, w.editor.id, w.owner.id}


def test_role_matrix_for_clearing_a_verdict(client, db):
    w = _world(db)
    for user in (w.reviewer, w.editor, w.owner):
        assert _put(client, w, user).status_code == 200

    for refused in (w.viewer, w.creator, w.direct):
        assert _clear(client, w, refused).status_code == 403, refused.name
    assert len(_rows(db, w.A)) == 3

    for user in (w.reviewer, w.editor, w.owner):
        assert _clear(client, w, user).status_code == 204, user.name
    assert _rows(db, w.A) == []


def test_only_owner_and_editor_remove_others_verdicts(client, db):
    w = _world(db)
    assert _put(client, w, w.reviewer).status_code == 200
    [row] = _rows(db, w.A)
    notified = len(_notifications(db, w.A))

    for refused in (w.reviewer, w.viewer, w.creator):
        r = _remove(client, w, refused, row.id)
        assert r.status_code == 403, (refused.name, r.text)
    assert len(_rows(db, w.A)) == 1

    r = _remove(client, w, w.editor, row.id)
    assert r.status_code == 204, r.text
    assert _rows(db, w.A) == []
    [log] = _logs(db, w.A, "verdict_removed")
    assert log.user_id == w.editor.id
    assert log.payload["removed_actor_name"] == "reviewer"
    assert len(_notifications(db, w.A)) == notified


def test_an_owner_removes_a_guests_verdict(client, db):
    w = _world(db)
    _, row = _guest_verdict(db, w)

    assert _remove(client, w, w.owner, row.id).status_code == 204
    assert _rows(db, w.A) == []


def test_a_verdict_id_from_another_asset_is_not_found(client, db):
    w = _world(db)
    assert _put(client, w, w.reviewer, asset=w.AF).status_code == 200
    [elsewhere] = _rows(db, w.AF)

    r = _remove(client, w, w.editor, elsewhere.id, asset=w.A)
    assert r.status_code == 404, r.text
    assert len(_rows(db, w.AF)) == 1
    assert _remove(client, w, w.editor, uuid.uuid4()).status_code == 404


# ── what is refused ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("status", ["pending", "maybe", "", "APPROVED"])
def test_pending_and_unknown_values_are_refused(client, db, status):
    w = _world(db)
    r = _put(client, w, w.editor, status)
    assert r.status_code == 422, r.text
    assert _rows(db, w.A) == []


def test_a_missing_version_id_is_refused(client, db):
    w = _world(db)
    assert client.put(f"/assets/{w.A.id}/verdict", json={"status": "approved"},
                      headers=_auth(w.editor)).status_code == 422
    assert client.delete(f"/assets/{w.A.id}/verdict", headers=_auth(w.editor)).status_code == 422
    assert client.get(f"/assets/{w.A.id}/verdicts", headers=_auth(w.editor)).status_code == 422


def test_a_version_of_another_asset_is_refused(client, db):
    w = _world(db)
    other = _v(w, w.AF)

    # The detail matters: FastAPI answers an unrouted path with a bare 404 too.
    for r in (_put(client, w, w.editor, version=other),
              _clear(client, w, w.editor, version=other),
              _list(client, w, w.editor, version=other),
              _put(client, w, w.editor, version=SimpleNamespace(id=uuid.uuid4()))):
        assert (r.status_code, r.json()) == (404, {"detail": "Version not found"})
    assert _rows(db, w.A) == [] and _rows(db, w.AF) == []


def test_a_deleted_version_is_refused(client, db):
    from datetime import datetime, timezone

    w = _world(db)
    _v(w).deleted_at = datetime.now(timezone.utc)
    db.flush()

    for r in (_put(client, w, w.editor), _clear(client, w, w.editor), _list(client, w, w.editor)):
        assert (r.status_code, r.json()) == (404, {"detail": "Version not found"})
    assert _rows(db, w.A) == []


def test_a_note_over_the_limit_is_refused(client, db):
    w = _world(db)
    assert _put(client, w, w.editor, note="x" * 5001).status_code == 422
    assert _put(client, w, w.editor, note="x" * 5000).status_code == 200


# ── trashed content ───────────────────────────────────────────────────────────

def _verdict_calls(client, w, asset, version):
    """Every verdict route, aimed at one asset, as the editor."""
    h = _auth(w.editor)
    vid = str(version.id)
    return [
        ("PUT verdict", lambda: client.put(f"/assets/{asset.id}/verdict",
                                           json={"version_id": vid, "status": "approved"}, headers=h)),
        ("DELETE verdict", lambda: client.delete(f"/assets/{asset.id}/verdict",
                                                 params={"version_id": vid}, headers=h)),
        ("DELETE verdicts/id", lambda: client.delete(f"/assets/{asset.id}/verdicts/{uuid.uuid4()}", headers=h)),
        ("GET verdicts", lambda: client.get(f"/assets/{asset.id}/verdicts",
                                            params={"version_id": vid}, headers=h)),
    ]


def test_trashed_project_answers_not_found_on_every_verdict_route(client, db):
    w = _world(db)
    assert _put(client, w, w.reviewer).status_code == 200
    [row] = _rows(db, w.A)

    # The control: on the live project each of these is a request the route accepts.
    assert _list(client, w, w.editor).status_code == 200
    assert _put(client, w, w.editor).status_code == 200
    assert _clear(client, w, w.editor).status_code == 204
    assert _remove(client, w, w.editor, row.id).status_code == 204
    assert _put(client, w, w.reviewer).status_code == 200
    [row] = _rows(db, w.A)

    _trash_project(client, db, w)

    refused = [(name, call()) for name, call in _verdict_calls(client, w, w.A, _v(w))]
    refused.append(("DELETE verdicts/id (a real one)", _remove(client, w, w.editor, row.id)))
    for name, r in refused:
        assert (r.status_code, r.json()) == (404, {"detail": "Project not found"}), name
    assert len(_rows(db, w.A)) == 1


def test_trashed_asset_answers_not_found_on_every_verdict_route(client, db):
    w = _world(db)
    assert client.delete(f"/assets/{w.A.id}", headers=_auth(w.owner)).status_code == 204
    db.expire_all()

    for name, call in _verdict_calls(client, w, w.A, _v(w)):
        r = call()
        assert (r.status_code, r.json()) == (404, {"detail": "Asset not found"}), name
    assert _rows(db, w.A) == []


def test_trashed_folder_answers_not_found_on_every_verdict_route(client, db):
    w = _world(db)
    assert client.delete(f"/folders/{w.F.id}", headers=_auth(w.owner)).status_code == 204
    db.expire_all()

    for name, call in _verdict_calls(client, w, w.AF, _v(w, w.AF)):
        r = call()
        assert (r.status_code, r.json()) == (404, {"detail": "Asset not found"}), name
    assert _rows(db, w.AF) == []


# ── giving, changing, clearing ────────────────────────────────────────────────

def test_the_response_names_the_verdict_and_its_giver(client, db):
    w = _world(db)
    r = _put(client, w, w.reviewer, "changes_requested", note="  tighten the cut  ")
    assert r.status_code == 200, r.text
    body = r.json()

    assert set(body) == {"id", "version_id", "status", "note", "created_at", "updated_at",
                         "who", "via_link_title", "is_mine"}
    assert body["version_id"] == str(_v(w).id)
    assert body["status"] == "changes_requested"
    assert body["note"] == "tighten the cut"
    assert body["is_mine"] is True
    assert body["via_link_title"] is None
    assert body["who"]["kind"] == "team"
    assert body["who"]["name"] == "reviewer"
    assert body["who"]["is_guest"] is False
    assert "email" not in r.text


def test_a_second_put_changes_the_verdict_in_place(client, db):
    w = _world(db)
    first = _put(client, w, w.editor, "approved", note="fine").json()
    second = _put(client, w, w.editor, "rejected").json()

    assert second["id"] == first["id"]
    assert second["status"] == "rejected"
    assert second["note"] is None
    assert len(_rows(db, w.A)) == 1


def test_giving_a_verdict_never_touches_the_asset_review_state(client, db):
    w = _world(db)
    before = w.A.status
    for status in ("approved", "changes_requested", "rejected"):
        assert _put(client, w, w.editor, status).status_code == 200
    assert _clear(client, w, w.editor).status_code == 204
    db.expire_all()
    assert w.A.status == before


@pytest.mark.parametrize("raw,stored", [("  hello  ", "hello"), (" \n\t ", None), ("", None), (None, None)])
def test_a_note_is_trimmed_at_the_route_edge(client, db, raw, stored):
    w = _world(db)
    r = _put(client, w, w.editor, note=raw)
    assert r.status_code == 200, r.text
    assert r.json()["note"] == stored
    [row] = _rows(db, w.A)
    assert row.note == stored


def test_clear_is_idempotent(client, db, mocks):
    w = _world(db)
    assert _put(client, w, w.editor).status_code == 200
    mocks.publish.reset_mock()

    assert _clear(client, w, w.editor).status_code == 204
    assert _rows(db, w.A) == []
    assert len(_logs(db, w.A, "verdict_cleared")) == 1
    mocks.publish.assert_called_once_with(w.project.id, "approval_updated", {
        "asset_id": str(w.A.id), "version_id": str(_v(w).id),
    })

    assert _clear(client, w, w.editor).status_code == 204
    assert len(_logs(db, w.A, "verdict_cleared")) == 1
    mocks.publish.assert_called_once()


def test_clearing_before_ever_giving_answers_204_and_writes_nothing(client, db, mocks):
    w = _world(db)
    assert _clear(client, w, w.reviewer).status_code == 204
    assert _logs(db, w.A, "verdict_cleared") == []
    mocks.publish.assert_not_called()
    mocks.send.assert_not_called()


def test_clearing_only_withdraws_the_callers_own_verdict(client, db):
    w = _world(db)
    assert _put(client, w, w.reviewer).status_code == 200
    assert _put(client, w, w.editor).status_code == 200
    _guest_verdict(db, w)

    assert _clear(client, w, w.editor).status_code == 204
    assert len(_rows(db, w.A)) == 2
    assert w.editor.id not in {row.user_id for row in _rows(db, w.A)}


def test_re_approving_after_a_clear_succeeds(client, db):
    """The partial unique index must not hold on to a cleared verdict."""
    w = _world(db)
    assert _put(client, w, w.editor, "approved").status_code == 200
    assert _clear(client, w, w.editor).status_code == 204
    r = _put(client, w, w.editor, "approved")
    assert r.status_code == 200, r.text
    assert _put(client, w, w.editor, "rejected").status_code == 200
    assert [row.status for row in _rows(db, w.A)] == [ApprovalStatus.rejected]


def test_verdicts_are_per_version(client, db):
    w = _world(db)
    v2 = AssetVersion(asset_id=w.A.id, version_number=2, created_by=w.owner.id,
                      processing_status=_v(w).processing_status)
    db.add(v2)
    db.flush()

    assert _put(client, w, w.editor, "approved").status_code == 200
    assert _put(client, w, w.editor, "rejected", version=v2).status_code == 200
    assert len(_rows(db, w.A)) == 2

    assert _clear(client, w, w.editor, version=v2).status_code == 204
    [row] = _rows(db, w.A)
    assert row.version_id == _v(w).id and row.status == ApprovalStatus.approved
    assert [v["status"] for v in _list(client, w, w.editor).json()] == ["approved"]
    assert _list(client, w, w.editor, version=v2).json() == []


# ── side effects come from the service, once ──────────────────────────────────

def test_giving_a_verdict_notifies_the_creator_once(client, db, mocks):
    w = _world(db)
    assert _put(client, w, w.reviewer, "changes_requested", note="softer").status_code == 200

    [n] = _notifications(db, w.A)
    assert n.user_id == w.owner.id
    assert (n.actor_name, n.detail) == ("reviewer", "changes_requested")
    mocks.send.assert_called_once()
    args, kwargs = mocks.send.call_args
    assert args == (send_approval_email,)
    assert kwargs["status"] == "changes_requested"
    assert kwargs["reviewer_name"] == "reviewer"
    assert kwargs["note"] == "softer"
    mocks.publish.assert_called_once_with(w.project.id, "approval_updated", {
        "asset_id": str(w.A.id), "version_id": str(_v(w).id), "status": "changes_requested",
    })


def test_the_creator_giving_a_verdict_notifies_nobody(client, db, mocks):
    w = _world(db)
    assert _put(client, w, w.owner).status_code == 200
    assert _notifications(db, w.A) == []
    mocks.send.assert_not_called()
    mocks.publish.assert_called_once()


# ── listing ───────────────────────────────────────────────────────────────────

def test_listing_shows_everyone_to_anyone_who_can_open_the_asset(client, db):
    w = _world(db)
    assert _put(client, w, w.reviewer, "approved").status_code == 200
    assert _put(client, w, w.editor, "rejected", note="no").status_code == 200
    guest, _ = _guest_verdict(db, w, "Dana")

    for viewer in (w.viewer, w.direct, w.editor, w.owner):
        r = _list(client, w, viewer)
        assert r.status_code == 200, (viewer.name, r.text)
        rows = r.json()
        assert {(v["who"]["name"], v["who"]["kind"], v["who"]["is_guest"], v["status"]) for v in rows} == {
            ("reviewer", "team", False, "approved"),
            ("editor", "team", False, "rejected"),
            ("Dana", "external", True, "rejected"),
        }
        assert {v["who"]["name"] for v in rows if v["is_mine"]} == (
            {"editor"} if viewer is w.editor else set())
        assert guest.email not in r.text
        assert "@" not in r.text


def test_listing_is_refused_to_someone_who_cannot_open_the_asset(client, db):
    w = _world(db)
    assert _list(client, w, w.creator).status_code == 403


def test_listing_leaves_out_other_versions_and_pending_rows(client, db):
    w = _world(db)
    assert _put(client, w, w.editor, "approved").status_code == 200
    db.add(Approval(asset_id=w.A.id, version_id=_v(w).id, user_id=w.viewer.id,
                    status=ApprovalStatus.pending))
    db.flush()

    assert [v["who"]["name"] for v in _list(client, w, w.owner).json()] == ["editor"]
    assert _list(client, w, w.owner, asset=w.AF).json() == []


# ── the legacy routes ─────────────────────────────────────────────────────────

LEGACY_KEYS = {"id", "asset_id", "version_id", "user_id", "status", "note", "created_at"}


def test_legacy_approve_route_still_answers_its_old_shape(client, db, mocks):
    w = _world(db)
    body = {"version_id": str(_v(w).id), "note": "  looks right  "}

    r = client.post(f"/assets/{w.A.id}/approve", json=body, headers=_auth(w.editor))
    assert r.status_code == 200, r.text
    approved = r.json()
    assert set(approved) == LEGACY_KEYS
    assert approved["status"] == "approved"
    assert approved["user_id"] == str(w.editor.id)
    assert approved["asset_id"] == str(w.A.id)
    assert approved["version_id"] == str(_v(w).id)
    assert approved["note"] == "looks right"

    r = client.post(f"/assets/{w.A.id}/reject", json={"version_id": str(_v(w).id)},
                    headers=_auth(w.editor))
    assert r.status_code == 200, r.text
    rejected = r.json()
    assert set(rejected) == LEGACY_KEYS
    assert rejected["status"] == "rejected"
    assert rejected["id"] == approved["id"]
    assert rejected["note"] is None

    # One verdict per person per version, and the new routes read what the old ones wrote.
    assert [v["status"] for v in _list(client, w, w.owner).json()] == ["rejected"]


def test_legacy_routes_notify_with_a_name_and_detail(client, db, mocks):
    w = _world(db)
    for path, detail in (("approve", "approved"), ("reject", "rejected")):
        r = client.post(f"/assets/{w.A.id}/{path}", json={"version_id": str(_v(w).id)},
                        headers=_auth(w.reviewer))
        assert r.status_code == 200, r.text

    assert {(n.actor_name, n.detail) for n in _notifications(db, w.A)} == {
        ("reviewer", "approved"), ("reviewer", "rejected")}
    assert mocks.send.call_count == 2
    assert [c.kwargs["status"] for c in mocks.send.call_args_list] == ["approved", "rejected"]
    assert [c.args[2] for c in mocks.publish.call_args_list] == [
        {"asset_id": str(w.A.id), "version_id": str(_v(w).id), "status": "approved"},
        {"asset_id": str(w.A.id), "version_id": str(_v(w).id), "status": "rejected"},
    ]
    assert {log.action for log in db.query(ActivityLog).filter(
        ActivityLog.asset_id == w.A.id).all()} == {"approved", "rejected"}


def test_legacy_routes_keep_their_role_check_and_refuse_a_foreign_version(client, db):
    w = _world(db)
    for path in ("approve", "reject"):
        denied = client.post(f"/assets/{w.A.id}/{path}", json={"version_id": str(_v(w).id)},
                             headers=_auth(w.viewer))
        assert denied.status_code == 403, path
        foreign = client.post(f"/assets/{w.A.id}/{path}", json={"version_id": str(_v(w, w.AF).id)},
                              headers=_auth(w.editor))
        assert foreign.status_code == 404, path
    assert _rows(db, w.A) == [] and _rows(db, w.AF) == []


def test_legacy_list_still_answers_when_a_guest_has_given_a_verdict(client, db):
    """`ApprovalResponse.user_id` is Optional now: a guest's row has no user."""
    w = _world(db)
    guest, _ = _guest_verdict(db, w)
    assert _put(client, w, w.editor, "approved").status_code == 200

    r = client.get(f"/assets/{w.A.id}/approvals", headers=_auth(w.viewer))

    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 2
    assert {row["user_id"] for row in rows} == {None, str(w.editor.id)}
    assert all(set(row) == LEGACY_KEYS for row in rows)
    assert guest.email not in r.text


@pytest.mark.parametrize("path", ["approve", "reject"])
def test_the_legacy_routes_cap_the_note_like_a_verdict_note(client, db, mocks, path):
    """The note lands in the same column, notification and email as a verdict's, so it
    carries the same 5000 limit instead of being the one unbounded way in."""
    w = _world(db)
    url = f"/assets/{w.A.id}/{path}"

    too_long = client.post(url, json={"version_id": str(_v(w).id), "note": "x" * 5001},
                           headers=_auth(w.editor))
    assert too_long.status_code == 422, too_long.text
    assert _rows(db, w.A) == []
    assert _notifications(db, w.A) == []
    mocks.send.assert_not_called()
    mocks.publish.assert_not_called()

    at_limit = client.post(url, json={"version_id": str(_v(w).id), "note": "x" * 5000},
                           headers=_auth(w.editor))
    assert at_limit.status_code == 200, at_limit.text
    assert len(at_limit.json()["note"]) == 5000
