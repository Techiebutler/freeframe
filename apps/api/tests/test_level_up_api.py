"""Nachtrag 7: undo an approval, and comments that survive a double tap (Idempotency-Key)."""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from .agent_pg import env, needs_pg  # noqa: F401

pytestmark = needs_pg


def link(e, folder_id, permission="approve"):
    from apps.api.models.share import ShareLink, SharePermission
    with e.Session() as db:
        l = ShareLink(folder_id=folder_id, token=uuid.uuid4().hex, created_by=e.owner.id, title="Review",
                      permission=SharePermission(permission), visibility="public")
        db.add(l)
        db.commit()
        return l.token


def approvals(e):
    from apps.api.models.approval import Approval
    with e.Session() as db:
        return db.query(Approval).all()


# ── Undo approve ──────────────────────────────────────────────────────────────

def test_logged_in_undo_removes_that_versions_approval_and_is_idempotent(env):
    a = env.asset(env.request(env.project_a, env.owner), "Hook 1", versions=2)
    h = env.headers(env.owner)
    for v in a.versions:
        assert env.client.post(f"/assets/{a.id}/approve", json={"version_id": str(v.id)}, headers=h).status_code == 200
    assert env.client.delete(f"/assets/{a.id}/approve?version_id={a.versions[0].id}", headers=h).status_code == 204
    assert [r.version_id for r in approvals(env)] == [a.versions[1].id]
    assert env.client.delete(f"/assets/{a.id}/approve?version_id={a.versions[0].id}", headers=h).status_code == 204   # nothing left: still 204
    assert env.client.delete(f"/assets/{a.id}/approve", headers=h).status_code == 204                                 # no version = latest
    assert approvals(env) == []


def test_logged_in_undo_needs_the_reviewer_role(env):
    a = env.asset(env.request(env.project_a, env.owner), "Hook 1")
    assert env.client.delete(f"/assets/{a.id}/approve", headers=env.headers(env.user("Stranger"))).status_code == 403


def test_share_undo_and_the_agent_sees_null_again(env):
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner)
    a = env.asset(req, "Hook 1", by=agent.who)
    token = link(env, req.folder_id)
    def approval():
        with patch("apps.api.services.review_bridge.asset_stats", return_value={}), patch("apps.api.services.review_bridge.request_status", return_value={}):
            return env.client.get("/agent/queue", headers=agent.headers).json()[0]["assets"][0]["approval"]
    env.client.post(f"/share/{token}/assets/{a.id}/approve", json={})
    assert approval() == "approved"
    url = f"/share/{token}/assets/{a.id}/approve?version_id={a.versions[0].id}"
    assert env.client.delete(url).status_code == 204 and approval() is None
    assert env.client.delete(url).status_code == 204


def test_share_undo_has_the_same_gates_as_approve(env):
    req, other = env.request(env.project_a, env.owner), env.request(env.project_a, env.owner, "Other")
    a, foreign = env.asset(req, "Hook 1"), env.asset(other, "Hook 9")
    comment_only = link(env, req.folder_id, "comment")
    r = env.client.delete(f"/share/{comment_only}/assets/{a.id}/approve")
    assert (r.status_code, r.json()["detail"]) == (403, "approve_not_allowed")
    token = link(env, req.folder_id)
    assert env.client.delete(f"/share/{token}/assets/{foreign.id}/approve").status_code == 404
    assert env.client.delete(f"/share/nope/assets/{a.id}/approve").status_code == 404


# ── Idempotency-Key ───────────────────────────────────────────────────────────

def post(e, asset, key=None, headers=None, text="Faster hook"):
    h = {**(headers or e.headers(e.owner)), **({"Idempotency-Key": key} if key else {})}
    return e.client.post(f"/assets/{asset.id}/comments", json={"version_id": str(asset.versions[-1].id), "body": text, "timecode_start": 1.0}, headers=h)


def comments(e):
    from apps.api.models.comment import Comment
    with e.Session() as db:
        return db.query(Comment).all()


def test_same_key_returns_the_existing_comment_with_200(env):
    a = env.asset(env.request(env.project_a, env.owner), "Hook 1")
    key = str(uuid.uuid4())
    first, again = post(env, a, key), post(env, a, key)
    assert (first.status_code, again.status_code) == (201, 200)
    assert first.json()["id"] == again.json()["id"] and len(comments(env)) == 1
    assert post(env, a, str(uuid.uuid4())).status_code == 201 and post(env, a).status_code == 201 and post(env, a).status_code == 201
    assert len(comments(env)) == 4                                            # other keys and no key are never merged


def test_a_key_belongs_to_its_author(env):
    a = env.asset(env.request(env.project_a, env.owner), "Hook 1")
    other = env.user("Other")
    from apps.api.models.project import ProjectMember, ProjectRole
    with env.Session() as db:
        db.add(ProjectMember(project_id=env.project_a.id, user_id=other.id, role=ProjectRole.editor))
        db.commit()
    key = str(uuid.uuid4())
    one, two = post(env, a, key), post(env, a, key, headers=env.headers(other))
    assert (one.status_code, two.status_code) == (201, 201) and one.json()["id"] != two.json()["id"]


def test_a_key_older_than_a_day_makes_a_new_comment(env):
    from apps.api.models.comment import Comment
    a = env.asset(env.request(env.project_a, env.owner), "Hook 1")
    key = str(uuid.uuid4())
    first = post(env, a, key).json()
    with env.Session() as db:
        db.get(Comment, uuid.UUID(first["id"])).created_at = datetime.now(timezone.utc) - timedelta(hours=25)
        db.commit()
    again = post(env, a, key)
    assert again.status_code == 201 and again.json()["id"] != first["id"]


def test_guest_share_comment_is_idempotent_per_guest(env):
    req = env.request(env.project_a, env.owner)
    a = env.asset(req, "Hook 1")
    token = link(env, req.folder_id, "comment")
    body = {"asset_id": str(a.id), "version_id": str(a.versions[0].id), "body": "Love it", "guest_name": "Anna", "guest_email": "anna@example.test"}
    key = {"Idempotency-Key": str(uuid.uuid4())}
    first, again = env.client.post(f"/share/{token}/comment", json=body, headers=key), env.client.post(f"/share/{token}/comment", json=body, headers=key)
    assert (first.status_code, again.status_code) == (201, 200) and first.json()["id"] == again.json()["id"]
    other = env.client.post(f"/share/{token}/comment", json={**body, "guest_email": "bob@example.test", "guest_name": "Bob"}, headers=key)
    assert other.status_code == 201 and other.json()["id"] != first.json()["id"]
    assert len(comments(env)) == 2
