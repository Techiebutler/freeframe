"""V3 client delivery (Veda retro, 2026-11-17): a client's share link shows people only; staff approve in it.

Seen live: a Veda client link showed every Auto Review note and "Claude on behalf of Alan" as creator, and Alan
had no Approve button on the agent's review link (permission `comment`).
"""
import uuid

from .agent_pg import env, needs_pg  # noqa: F401

pytestmark = needs_pg


def link(e, folder_id, permission="comment"):
    from apps.api.models.share import ShareLink, SharePermission
    with e.Session() as db:
        l = ShareLink(folder_id=folder_id, token=uuid.uuid4().hex, created_by=e.owner.id, title="Review",
                      permission=SharePermission(permission), visibility="public")
        db.add(l)
        db.commit()
        return l.token


def staff(e):
    from apps.api.models.user import User
    with e.Session() as db:
        u = User(email=f"alan-{uuid.uuid4().hex[:6]}@aditor.ai", name="Alan")
        db.add(u)
        db.commit()
        return u


def agent_user(e):
    from apps.api.models.user import User
    with e.Session() as db:
        u = User(email=f"agent+{uuid.uuid4().hex[:6]}@agents.autoreview.local", name="Claude on behalf of Alan (claude-code)",
                 kind="agent", is_staff=False)
        db.add(u)
        db.commit()
        return u


def veda(e):
    """A delivery like Veda's: the agent uploaded it; Auto Review, the agent and the client commented."""
    from apps.api.models.asset import Asset
    from apps.api.models.comment import Comment
    from apps.api.models.user import GuestUser
    agent = agent_user(e)
    req = e.request(e.project_a, e.owner, "Black Friday UGC 3")
    a = e.asset(req, "Hook 1 - Veda Black Friday UGC 3 final8")
    v = a.versions[0].id
    with e.Session() as db:
        db.get(Asset, a.id).created_by = agent.id
        auto, client = GuestUser(email=f"auto-{uuid.uuid4().hex[:6]}@review.test", name="Auto Review"), \
            GuestUser(email=f"stephan-{uuid.uuid4().hex[:6]}@veda.test", name="Stephan")
        db.add_all([auto, client])
        db.flush()
        db.add_all([
            Comment(asset_id=a.id, version_id=v, guest_author_id=auto.id, body="Frame jump at 0:03", visibility="internal",
                    review_source={"kind": "auto"}, review_publication_id=uuid.uuid4()),
            Comment(asset_id=a.id, version_id=v, guest_author_id=auto.id, body="Caption too low", review_source={"kind": "auto"}),
            Comment(asset_id=a.id, version_id=v, author_id=agent.id, body="Fixed in v8, music added"),
            Comment(asset_id=a.id, version_id=v, guest_author_id=client.id, body="Voice sounds shrill here", timecode_start=4.2),
        ])
        db.commit()
    return req, a, agent


def bodies(r):
    assert r.status_code == 200, r.text
    return sorted(c["body"] for c in r.json())


def test_a_client_sees_only_people_and_aditor_as_creator(env):
    req, a, _ = veda(env)
    token = link(env, req.folder_id)
    assert bodies(env.client.get(f"/share/{token}/comments", params={"asset_id": str(a.id)})) == ["Voice sounds shrill here"]
    [item] = env.client.get(f"/share/{token}/assets").json()["assets"]
    assert (item["created_by_name"], item["comment_count"], item["auto_comment_count"]) == ("Aditor", 1, 0)
    info = env.client.get(f"/share/{token}").json()
    assert info["viewer_is_staff"] is False


def test_a_signed_in_client_is_still_a_client(env):
    req, a, _ = veda(env)
    token = link(env, req.folder_id)
    client = env.user("Stephan")  # @example.test, User.is_staff defaults to true: still not Aditor staff
    r = env.client.get(f"/share/{token}/comments", params={"asset_id": str(a.id)}, headers=env.headers(client))
    assert bodies(r) == ["Voice sounds shrill here"]


def test_staff_see_everything(env):
    req, a, agent = veda(env)
    token = link(env, req.folder_id)
    h = env.headers(staff(env))
    assert len(bodies(env.client.get(f"/share/{token}/comments", params={"asset_id": str(a.id)}, headers=h))) == 4
    [item] = env.client.get(f"/share/{token}/assets", headers=h).json()["assets"]
    assert (item["created_by_name"], item["comment_count"], item["auto_comment_count"]) == (agent.name, 1, 3)
    assert env.client.get(f"/share/{token}", headers=h).json()["viewer_is_staff"] is True


def approvals(e):
    from apps.api.models.approval import Approval
    with e.Session() as db:
        return db.query(Approval).all()


def test_staff_approve_on_the_review_link_as_themselves_and_can_undo(env):
    req, a, _ = veda(env)
    token, alan = link(env, req.folder_id), staff(env)
    for _ in range(2):  # idempotent
        r = env.client.post(f"/share/{token}/assets/{a.id}/approve", json={}, headers=env.headers(alan))
        assert r.status_code == 200, r.text
    [row] = approvals(env)
    assert (row.user_id, row.status.value) == (alan.id, "approved") and row.created_at is not None
    assert env.client.delete(f"/share/{token}/assets/{a.id}/approve", headers=env.headers(alan)).status_code == 204
    assert approvals(env) == []


def test_agents_and_clients_never_approve(env):
    req, a, agent = veda(env)
    comment_link, approve_link = link(env, req.folder_id), link(env, req.folder_id, "approve")
    for token in (comment_link, approve_link):
        for headers in ({"Authorization": "Bearer ara_not_a_jwt"}, env.headers(agent)):
            r = env.client.post(f"/share/{token}/assets/{a.id}/approve", json={}, headers=headers)
            assert (r.status_code, r.json()["detail"]) == (403, "agents_may_not_approve")
    for headers in ({}, env.headers(env.user("Stephan"))):
        r = env.client.post(f"/share/{comment_link}/assets/{a.id}/approve", json={}, headers=headers)
        assert (r.status_code, r.json()["detail"]) == (403, "approve_not_allowed")
    assert approvals(env) == []
