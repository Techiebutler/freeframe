"""P2/P3 backend: the agent's queue, review, approve gate, rule suggestions, and attributed uploads."""
import uuid
from unittest.mock import patch

import pytest

from .agent_pg import env, needs_pg  # noqa: F401

pytestmark = needs_pg


def clear(version, open_must_fix=0):
    return {"version_id": str(version.id), "reviewed": True, "openMustFix": open_must_fix}


def bridge(req, status="clear", must_fixes=0):
    return {req.review_share_token: {"status": status, "openMustFixes": must_fixes}}


def patched(stats=None, statuses=None):
    return (patch("apps.api.services.review_bridge.asset_stats", return_value=stats or {}),
            patch("apps.api.services.review_bridge.request_status", return_value=statuses or {}))


def reviewer_note(env, asset, version, body, t=3.2, source=None):
    from apps.api.models.comment import Comment
    from apps.api.models.user import GuestUser
    from apps.api.routers.requests import REVIEWER_EMAIL
    with env.Session() as db:
        g = db.query(GuestUser).filter_by(email=REVIEWER_EMAIL).first()
        if not g:
            g = GuestUser(email=REVIEWER_EMAIL, name="Auto Review")
            db.add(g)
            db.flush()
        db.add(Comment(asset_id=asset.id, version_id=version.id, guest_author_id=g.id, body=body, timecode_start=t, review_source=source))
        db.commit()


def test_queue_stages_follow_the_kanban(env):
    agent = env.pair_agent(env.project_a)
    editor = env.request(env.project_a, env.owner, "Waiting")            # no assets -> editor
    ready = env.request(env.project_a, env.owner, "Ready")
    held = env.request(env.project_a, env.owner, "Held")
    reviewing = env.request(env.project_a, env.owner, "Reviewing")
    a_ready, a_held, a_rev = env.asset(ready), env.asset(held), env.asset(reviewing)
    stats = {str(a_ready.id): clear(a_ready.versions[0]), str(a_held.id): clear(a_held.versions[0], 2),
             str(a_rev.id): {"version_id": str(a_rev.versions[0].id), "reviewed": False, "progress": {"stage": "reading", "version_id": str(a_rev.versions[0].id)}}}
    statuses = {**bridge(ready), **bridge(held, "held", 2), **bridge(reviewing, "reviewing")}
    p1, p2 = patched(stats, statuses)
    with p1, p2:
        rows = env.client.get("/agent/queue", headers=agent.headers).json()
        by = {r["title"]: r for r in rows}
        assert {t: r["stage"] for t, r in by.items()} == {"Waiting": "editor", "Ready": "ready", "Held": "corrections", "Reviewing": "review"}
        assert by["Ready"]["upload_token"] and by["Ready"]["folder_id"] and by["Ready"]["request_id"] == str(ready.id)
        asset = by["Held"]["assets"][0]
        assert asset == {"asset_id": str(a_held.id), "name": "Hook 1", "version_id": str(a_held.versions[0].id),
                         "version_number": 1, "review_state": "held", "processing_status": "ready", "approval": None}
        only = env.client.get("/agent/queue?state=corrections", headers=agent.headers).json()
        assert [r["title"] for r in only] == ["Held"]
    assert env.client.get("/agent/queue?state=nope", headers=agent.headers).status_code == 422


def test_queue_never_shows_another_project(env):
    agent = env.pair_agent(env.project_a)
    env.request(env.project_b, env.owner, "Other brand")
    p1, p2 = patched()
    with p1, p2:
        assert env.client.get("/agent/queue", headers=agent.headers).json() == []


def test_review_splits_must_fix_from_guidance(env):
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner)
    a = env.asset(req)
    reviewer_note(env, a, a.versions[0], "Must fix — Hook is slow", 3.2,
                  {"schema_version": "autoreview.comment-source.v1", "requirement_id": "hook-speed",
                   "sources": [{"layer": "brand", "reference_id": "r1", "source_version": "1"}]})
    reviewer_note(env, a, a.versions[0], "Consider a tighter outro", None)
    p1, p2 = patched({str(a.id): clear(a.versions[0], 1)}, bridge(req, "held", 1))
    with p1, p2:
        r = env.client.get(f"/agent/assets/{a.id}/review", headers=agent.headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["review_state"] == "held" and body["gate"] == {"status": "held", "open_must_fixes": 1}
    assert body["version_id"] == str(a.versions[0].id)
    assert body["must_fix"] == [{"t": 3.2, "rule": "hook-speed", "text": "Hook is slow"}]
    assert body["guidance"] == [{"t": None, "rule": "", "text": "Consider a tighter outro"}]


def test_foreign_project_asset_is_404_everywhere(env):
    agent = env.pair_agent(env.project_a)
    a = env.asset(env.request(env.project_b, env.owner))
    p1, p2 = patched()
    with p1, p2:
        assert env.client.get(f"/agent/assets/{a.id}/review", headers=agent.headers).status_code == 404
        assert env.client.post(f"/agent/assets/{a.id}/approve", headers=agent.headers).status_code == 404
    assert env.client.get(f"/agent/assets/{uuid.uuid4()}/review", headers=agent.headers).status_code == 404


def test_approve_is_off_by_default_and_on_with_the_flag(env):
    agent = env.pair_agent(env.project_a)
    a = env.asset(env.request(env.project_a, env.owner))
    r = env.client.post(f"/agent/assets/{a.id}/approve", headers=agent.headers)
    assert (r.status_code, r.json()["detail"]) == (403, "agents_may_not_approve")
    env.client.patch(f"/projects/{env.project_a.id}", json={"agents_may_approve": True}, headers=env.headers(env.owner))
    assert env.client.post(f"/agent/assets/{a.id}/approve", headers=agent.headers).status_code == 200
    from apps.api.models.approval import Approval, ApprovalStatus
    with env.Session() as db:
        row = db.query(Approval).one()
        assert (str(row.user_id), row.status, row.version_id) == (agent.user_id, ApprovalStatus.approved, a.versions[0].id)


def test_rule_suggestion_goes_to_the_rules_import_of_the_projects_brand(env):
    agent = env.pair_agent(env.project_a)
    with patch("apps.api.services.review_bridge.import_rules", return_value={"ok": True, "drafted": 1}) as imp:
        r = env.client.post("/agent/rules/suggestion", json={"text": "Never open on a logo", "evidence": "Hook 2 v1"}, headers=agent.headers)
    assert r.status_code == 200 and r.json()["suggestion_id"]
    assert "Never open on a logo" in imp.call_args.args[1] and "Hook 2 v1" in imp.call_args.args[1]
    with patch("apps.api.services.review_bridge.import_rules", return_value=None):
        assert env.client.post("/agent/rules/suggestion", json={"text": "Never open on a logo"}, headers=agent.headers).status_code == 503


def test_agent_upload_is_attributed_to_the_agent_user(env):
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner)
    body = {"original_filename": "Hook 1.mp4", "mime_type": "video/mp4", "file_size_bytes": 1000}
    with patch("apps.api.routers.requests.create_multipart_upload", return_value="uid"):
        r = env.client.post(f"/r/{req.token}/upload/initiate", json=body, headers=agent.headers)
        assert r.status_code == 200, r.text
        # an agent of ANOTHER project is turned away
        other = env.pair_agent(env.project_b, "Other")
        assert env.client.post(f"/r/{req.token}/upload/initiate", json=body, headers=other.headers).status_code == 404
        # a guest without a key still works as before (identity-less initiate)
        assert env.client.post(f"/r/{req.token}/upload/initiate", json=body).status_code == 200
    from apps.api.models.asset import AssetVersion
    from apps.api.models.upload_request import RequestUpload
    with env.Session() as db:
        rec = db.query(RequestUpload).one()
        assert rec.uploader_name == "Cutter (codex)" and rec.uploader_email.endswith("@agents.autoreview.local")
        v = db.get(AssetVersion, uuid.UUID(r.json()["version_id"]))
        assert str(v.created_by) == agent.user_id
