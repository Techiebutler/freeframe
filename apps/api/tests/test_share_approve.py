"""Approve from a folder share link (phone review) and the agent seeing it on the queue."""
import uuid
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


def test_guest_approves_the_latest_version_through_a_folder_link(env):
    req = env.request(env.project_a, env.owner)
    a = env.asset(req, "Hook 1", versions=2)
    r = env.client.post(f"/share/{link(env, req.folder_id)}/assets/{a.id}/approve", json={})
    assert r.status_code == 200, r.text
    [row] = approvals(env)
    assert (row.asset_id, row.version_id, row.user_id, row.status.value) == (a.id, a.versions[1].id, env.owner.id, "approved")
    assert r.json() == {"asset_id": str(a.id), "version_id": str(a.versions[1].id), "status": "approved"}


def test_an_explicit_version_and_a_repeat_are_idempotent(env):
    req = env.request(env.project_a, env.owner)
    a = env.asset(req, "Hook 1", versions=2)
    token = link(env, req.folder_id)
    for _ in range(2):
        assert env.client.post(f"/share/{token}/assets/{a.id}/approve", json={"version_id": str(a.versions[0].id)}).status_code == 200
    [row] = approvals(env)
    assert row.version_id == a.versions[0].id
    assert env.client.post(f"/share/{token}/assets/{a.id}/approve", json={"version_id": str(uuid.uuid4())}).status_code == 404


def test_only_approve_links_may_approve(env):
    req = env.request(env.project_a, env.owner)
    a = env.asset(req, "Hook 1")
    for permission in ("view", "comment"):
        r = env.client.post(f"/share/{link(env, req.folder_id, permission)}/assets/{a.id}/approve", json={})
        assert (r.status_code, r.json()["detail"]) == (403, "approve_not_allowed")
    assert approvals(env) == []


def test_assets_outside_the_shared_folder_and_unknown_links_are_404(env):
    mine, other = env.request(env.project_a, env.owner, "Mine"), env.request(env.project_a, env.owner, "Other")
    foreign = env.asset(other, "Hook 9")
    token = link(env, mine.folder_id)
    assert env.client.post(f"/share/{token}/assets/{foreign.id}/approve", json={}).status_code == 404
    assert env.client.post(f"/share/{token}/assets/{uuid.uuid4()}/approve", json={}).status_code == 404
    assert env.client.post(f"/share/nope/assets/{foreign.id}/approve", json={}).status_code == 404
    assert approvals(env) == []


def test_the_agent_sees_the_approval_on_the_newest_version_only(env):
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner)
    a = env.asset(req, "Hook 1", by=agent.who)
    def queue():
        with patch("apps.api.services.review_bridge.asset_stats", return_value={}), patch("apps.api.services.review_bridge.request_status", return_value={}):
            return env.client.get("/agent/queue", headers=agent.headers).json()[0]["assets"][0]["approval"]
    assert queue() is None
    assert env.client.post(f"/share/{link(env, req.folder_id)}/assets/{a.id}/approve", json={}).status_code == 200
    assert queue() == "approved"
    from apps.api.models.asset import AssetVersion
    from apps.api.models.asset import ProcessingStatus
    with env.Session() as db:
        db.add(AssetVersion(asset_id=a.id, version_number=2, processing_status=ProcessingStatus.ready, created_by=env.owner.id))
        db.commit()
    assert queue() is None                                              # a new version is not approved yet
