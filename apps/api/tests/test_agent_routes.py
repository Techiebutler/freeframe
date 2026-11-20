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
    other = env.user("Other")  # another OWNER; a second brand of the same owner is in the workspace
    env.request(env.project(other, "Foreign"), other, "Other brand")
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
    other = env.user("Other")  # another OWNER; a second brand of the same owner is in the workspace
    a = env.asset(env.request(env.project(other, "Foreign"), other))
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


def test_embed_url_is_made_once_per_request_with_approve_and_stays_in_the_project(env):
    from apps.api.models.share import ShareLink, SharePermission
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner, "Cut")
    empty = env.request(env.project_a, env.owner, "Empty")
    a = env.asset(req)
    p1, p2 = patched({str(a.id): clear(a.versions[0])}, bridge(req))
    with p1, p2:
        first = {r["title"]: r for r in env.client.get("/agent/queue", headers=agent.headers).json()}
        again = {r["title"]: r for r in env.client.get("/agent/queue", headers=agent.headers).json()}
        review = env.client.get(f"/agent/assets/{a.id}/review", headers=agent.headers).json()
    url = first["Cut"]["embed_url"]
    assert url.endswith("?embed=1") and "/share/" in url and url.split("?")[0] != first["Cut"]["review_url"]
    assert again["Cut"]["embed_url"] == url == review["embed_url"]
    assert first["Empty"]["embed_url"] is None
    token = url.split("/share/")[1].split("?")[0]
    with env.Session() as db:
        links = db.query(ShareLink).filter(ShareLink.folder_id == req.folder_id, ShareLink.token == token).all()
        assert len(links) == 1 and links[0].permission == SharePermission.approve and links[0].created_by == env.owner.id
        assert db.query(ShareLink).filter(ShareLink.folder_id == empty.folder_id).count() == 0


def _round(env, req, closed_after=None, acked=False):
    """A feedback round for `req`, closed `closed_after` seconds from now (None = still open)."""
    from datetime import datetime, timedelta, timezone
    from apps.api.models.agent import FeedbackRound
    now = datetime.now(timezone.utc)
    with env.Session() as db:
        db.add(FeedbackRound(request_id=req.id, closed_at=None if closed_after is None else now + timedelta(seconds=closed_after),
                             acked_at=now if acked else None))
        db.commit()


def test_queue_feedback_sent_follows_the_round_and_versions(env):
    agent = env.pair_agent(env.project_a)
    reqs = [env.request(env.project_a, env.owner, t) for t in ("Sent", "Acked", "Newer", "None", "Open")]
    sent, acked, newer, none, openr = reqs
    assets = [env.asset(q) for q in reqs]
    _round(env, sent, closed_after=5)                 # (a) closed after the version, not acked
    _round(env, acked, closed_after=5, acked=True)    # (b) acked
    _round(env, newer, closed_after=-60)              # (c) a newer version came after the round closed
    _round(env, openr)                                # a still-open round is not "sent"
    p1, p2 = patched({str(a.id): clear(a.versions[0]) for a in assets}, {q.review_share_token: {"status": "clear", "openMustFixes": 0} for q in reqs})
    with p1, p2:
        by = {r["title"]: r for r in env.client.get("/agent/queue", headers=agent.headers).json()}
    assert {t: r["feedback_sent"] for t, r in by.items()} == {"Sent": True, "Acked": False, "Newer": False, "None": False, "Open": False}  # (d) no round
    assert all(r["stage"] == "ready" for r in by.values())   # stage untouched


# ── workspace reach: every brand of the key's owner, never another owner's ──────

def test_second_brand_of_the_owner_is_reachable_for_queue_review_feedback_ack(env):
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_b, env.owner, "Networther hook")
    a = env.asset(req, by=agent.who)
    _round(env, req, closed_after=-1)
    p1, p2 = patched({str(a.id): clear(a.versions[0])}, bridge(req))
    with p1, p2:
        rows = env.client.get("/agent/queue", headers=agent.headers).json()
        assert [r["request_id"] for r in rows] == [str(req.id)] and rows[0]["upload_token"] == req.token
        assert env.client.get("/agent/queue?state=ready", headers=agent.headers).json()[0]["request_id"] == str(req.id)
        review = env.client.get(f"/agent/assets/{a.id}/review", headers=agent.headers)
        assert review.status_code == 200 and review.json()["asset_id"] == str(a.id)
    rounds = env.client.get("/agent/feedback", headers=agent.headers).json()["rounds"]
    assert [r["request_id"] for r in rounds] == [str(req.id)]
    assert env.client.post(f"/agent/feedback/{rounds[0]['round_id']}/ack", headers=agent.headers).status_code == 204
    assert env.client.get("/agent/feedback", headers=agent.headers).json()["rounds"] == []


def test_approve_in_second_brand_follows_that_brands_flag(env):
    agent = env.pair_agent(env.project_a)
    a = env.asset(env.request(env.project_b, env.owner))
    r = env.client.post(f"/agent/assets/{a.id}/approve", headers=agent.headers)
    assert (r.status_code, r.json()["detail"]) == (403, "agents_may_not_approve")
    env.client.patch(f"/projects/{env.project_a.id}", json={"agents_may_approve": True}, headers=env.headers(env.owner))
    assert env.client.post(f"/agent/assets/{a.id}/approve", headers=agent.headers).status_code == 403  # the home flag does not leak
    env.client.patch(f"/projects/{env.project_b.id}", json={"agents_may_approve": True}, headers=env.headers(env.owner))
    assert env.client.post(f"/agent/assets/{a.id}/approve", headers=agent.headers).status_code == 200


def test_another_owners_project_is_invisible_to_every_agent_route(env):
    other = env.user("Other")
    foreign = env.project(other, "Foreign")
    agent = env.pair_agent(env.project_a)
    req = env.request(foreign, other)
    a = env.asset(req, by=agent.who)
    _round(env, req, closed_after=-1)
    env.client.patch(f"/projects/{foreign.id}", json={"agents_may_approve": True}, headers=env.headers(other))
    p1, p2 = patched({str(a.id): clear(a.versions[0])}, bridge(req))
    with p1, p2:
        assert env.client.get("/agent/queue", headers=agent.headers).json() == []
        assert env.client.get(f"/agent/assets/{a.id}/review", headers=agent.headers).status_code == 404
        assert env.client.post(f"/agent/assets/{a.id}/approve", headers=agent.headers).status_code == 404
    assert env.client.get("/agent/feedback", headers=agent.headers).json()["rounds"] == []
    from apps.api.models.agent import FeedbackRound
    with env.Session() as db:
        rid = db.query(FeedbackRound).one().id
    assert env.client.post(f"/agent/feedback/{rid}/ack", headers=agent.headers).status_code == 404


def test_queue_request_with_every_part_approved_is_ready_despite_a_held_gate(env):
    from apps.api.models.approval import Approval, ApprovalStatus
    agent = env.pair_agent(env.project_a)
    both = env.request(env.project_a, env.owner, "Both approved")
    one = env.request(env.project_a, env.owner, "One approved")
    b1, b2, o1, o2 = env.asset(both), env.asset(both), env.asset(one), env.asset(one)
    with env.Session() as db:
        for a in (b1, b2, o1):
            db.add(Approval(asset_id=a.id, version_id=a.versions[0].id, user_id=env.owner.id, status=ApprovalStatus.approved))
        db.commit()
    stats = {str(b1.id): clear(b1.versions[0], 2), str(b2.id): clear(b2.versions[0]),
             str(o1.id): clear(o1.versions[0], 2), str(o2.id): clear(o2.versions[0])}
    p1, p2 = patched(stats, {**bridge(both, "held", 2), **bridge(one, "held", 2)})
    with p1, p2:
        by = {r["title"]: r["stage"] for r in env.client.get("/agent/queue", headers=agent.headers).json()}
        assert by == {"Both approved": "ready", "One approved": "corrections"}
        ready = env.client.get("/agent/queue?state=ready", headers=agent.headers).json()
        assert [r["title"] for r in ready] == ["Both approved"]
