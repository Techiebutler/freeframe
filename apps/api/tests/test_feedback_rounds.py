"""P4/P5 backend: rounds open on human comments, close on button or idle, FeedbackV1, agent cursor + ack."""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from .agent_pg import env, needs_pg  # noqa: F401

T0 = datetime(2026, 11, 4, 10, 0, tzinfo=timezone.utc)


# ── Pure ──────────────────────────────────────────────────────────────────────

INK = {"format": "ink.v1", "mark_offset_ms": 420, "marks": [{"t": 3.2, "offset_ms": 420, "points": [[0.1, 0.2], [0.3, 0.4]]}]}

def test_idle_is_five_minutes_since_the_latest_activity():
    from apps.api.services.feedback_rounds import is_idle
    assert not is_idle(T0, None, T0 + timedelta(minutes=4, seconds=59))
    assert is_idle(T0, None, T0 + timedelta(minutes=5))
    # a comment newer than the last heartbeat restarts the clock
    assert not is_idle(T0, T0 + timedelta(minutes=3), T0 + timedelta(minutes=7))
    assert is_idle(T0, T0 + timedelta(minutes=3), T0 + timedelta(minutes=8))


def test_feedback_v1_snapshot():
    from apps.api.services.feedback_rounds import build_feedback_v1
    rid, qid, pid = (uuid.UUID(int=i) for i in (1, 2, 3))
    out = build_feedback_v1(
        round_id=rid, request_id=qid, project_id=pid, briefing="Hook tests", opened_at=T0,
        closed_at=T0 + timedelta(minutes=6), closed_by="idle", context_base="https://review.aditor.ai/",
        files=[
            {"asset_id": "b", "version_id": "vb", "name": "Hook 2", "version_number": 1, "comments": []},
            {"asset_id": "a", "version_id": "va", "name": "Hook 1", "version_number": 2, "comments": [
                {"comment_id": "c2", "t_start": None, "t_end": None, "text": "Louder music", "drawing": None, "author": "Anna", "author_kind": "guest"},
                {"comment_id": "c1", "t_start": 3.2, "t_end": None, "text": "Hook too slow",
                 "drawing": {"drawing_data": INK, "frame_url": "https://x/t.jpg", "mark_offset_ms": 420}, "author": "Alan Simon", "author_kind": "human"}]}])
    assert out == {
        "schema": "feedback.v1", "round_id": str(rid), "request_id": str(qid), "project_id": str(pid), "briefing": "Hook tests",
        "opened_at": "2026-11-04T10:00:00+00:00", "closed_at": "2026-11-04T10:06:00+00:00", "closed_by": "idle",
        "files": [
            {"asset_id": "a", "version_id": "va", "name": "Hook 1", "version_number": 2, "comments": [
                {"comment_id": "c2", "t_start": None, "t_end": None, "text": "Louder music", "drawing": None, "author": "Anna", "author_kind": "guest"},
                {"comment_id": "c1", "t_start": 3.2, "t_end": None, "text": "Hook too slow",
                 "drawing": {"drawing_data": INK, "frame_url": "https://x/t.jpg", "mark_offset_ms": 420}, "author": "Alan Simon", "author_kind": "human"}]},
            {"asset_id": "b", "version_id": "vb", "name": "Hook 2", "version_number": 1, "comments": []}],
        "context_url": f"https://review.aditor.ai/api/v1/agents/context?project={pid}"}


def test_every_human_note_is_a_rule_candidate_standing_ones_first():
    from apps.api.services.feedback_rounds import rule_candidates
    rid = uuid.uuid4()
    got = rule_candidates(rid, [
        {"comment_id": "c1", "t_start": 3.2, "text": "Hook too slow here"},
        {"comment_id": "c2", "t_start": None, "text": "  Always end on the product shot "},
        {"comment_id": "c3", "t_start": 0.0, "text": "ok"},
        {"comment_id": "c4", "t_start": None, "text": "   "}])
    assert [(g["comment_id"], g["text"], g["scope"]) for g in got] == [
        ("c2", "Always end on the product shot", "standing"), ("c1", "Hook too slow here", "scene"), ("c3", "ok", "scene")]
    assert rule_candidates(rid, [{"comment_id": "c2", "t_start": None, "text": "x"}])[0]["suggestion_id"] == \
        rule_candidates(rid, [{"comment_id": "c2", "t_start": None, "text": "x"}])[0]["suggestion_id"]


# ── Postgres ──────────────────────────────────────────────────────────────────

def comment(e, asset, text="Make the hook faster", t=3.2, headers=None, annotation=None):
    body = {"version_id": str(asset.versions[-1].id), "body": text, "timecode_start": t}
    if annotation:
        body["annotation"] = annotation
    r = e.client.post(f"/assets/{asset.id}/comments", json=body, headers=headers or e.headers(e.owner))
    assert r.status_code == 201, r.text
    return r.json()


def rounds(e):
    from apps.api.models.agent import FeedbackRound
    with e.Session() as db:
        return db.query(FeedbackRound).order_by(FeedbackRound.opened_at).all()


@pytest.fixture
def scene(env):
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner, "Hook tests")
    asset = env.asset(req, "Hook 1", by=agent.who)
    env.scene = type("S", (), {"agent": agent, "req": req, "asset": asset})
    return env


@needs_pg
def test_first_human_comment_opens_one_round_and_the_second_joins_it(scene):
    e = scene
    comment(e, e.scene.asset)
    comment(e, e.scene.asset, "And the logo", 5.0)
    assert len(rounds(e)) == 1 and rounds(e)[0].closed_at is None


@needs_pg
def test_agent_and_reviewer_comments_do_not_open_a_round(scene):
    e = scene
    from apps.api.models.comment import Comment
    from apps.api.models.user import GuestUser
    from apps.api.services import feedback_rounds
    with e.Session() as db:
        bot = GuestUser(email="review@aditor.ai", name="Auto Review")
        db.add(bot)
        db.flush()
        c = Comment(asset_id=e.scene.asset.id, version_id=e.scene.asset.versions[0].id, guest_author_id=bot.id, body="Must fix - x", created_at=T0)
        agent_c = Comment(asset_id=e.scene.asset.id, version_id=e.scene.asset.versions[0].id, author_id=uuid.UUID(e.scene.agent.user_id), body="done", created_at=T0)
        db.add_all([c, agent_c])
        db.commit()
        feedback_rounds.on_comment(db, c.id)
        feedback_rounds.on_comment(db, agent_c.id)
    assert rounds(e) == []


@needs_pg
def test_a_guest_comment_opens_a_round(scene):
    e = scene
    from apps.api.models.comment import Comment
    from apps.api.models.user import GuestUser
    from apps.api.services import feedback_rounds
    with e.Session() as db:
        g = GuestUser(email="client@example.test", name="Client")
        db.add(g)
        db.flush()
        c = Comment(asset_id=e.scene.asset.id, version_id=e.scene.asset.versions[0].id, guest_author_id=g.id, body="Love it", created_at=T0)
        db.add(c)
        db.commit()
        feedback_rounds.on_comment(db, c.id)
    assert len(rounds(e)) == 1


@needs_pg
def test_close_button_returns_feedback_v1_then_a_new_comment_opens_a_new_round(scene):
    e = scene
    c = comment(e, e.scene.asset, t=3.2004, annotation={"drawing_data": INK})
    r = e.client.post(f"/requests/{e.scene.req.id}/feedback-rounds/close", json={"reason": "button"}, headers=e.headers(e.owner))
    assert r.status_code == 200, r.text
    v1 = r.json()
    assert v1["schema"] == "feedback.v1" and v1["closed_by"] == "button" and v1["briefing"] == "Hook tests"
    assert v1["project_id"] == str(e.project_a.id) and v1["request_id"] == str(e.scene.req.id)
    assert v1["context_url"].endswith(f"/api/v1/agents/context?project={e.project_a.id}")
    [f] = v1["files"]
    assert (f["name"], f["version_number"], f["asset_id"]) == ("Hook 1", 1, str(e.scene.asset.id))
    [note] = f["comments"]
    assert note["comment_id"] == c["id"] and note["text"] == "Make the hook faster" and note["t_start"] == 3.2
    assert note["author"] == "Owner" and note["author_kind"] == "human"
    assert note["drawing"] == {"drawing_data": INK, "frame_url": None, "mark_offset_ms": 420}   # passed through unchanged
    # nothing open any more -> 409; a later comment opens round #2 that excludes the first comment
    again = e.client.post(f"/requests/{e.scene.req.id}/feedback-rounds/close", json={"reason": "button"}, headers=e.headers(e.owner))
    assert (again.status_code, again.json()["detail"]) == (409, "no_open_round")
    comment(e, e.scene.asset, "One more", 9.0)
    assert len(rounds(e)) == 2 and rounds(e)[1].closed_at is None
    second = e.client.post(f"/requests/{e.scene.req.id}/feedback-rounds/close", json={}, headers=e.headers(e.owner)).json()
    assert [n["text"] for n in second["files"][0]["comments"]] == ["One more"]


@needs_pg
def test_only_the_owner_closes_a_round(scene):
    e = scene
    comment(e, e.scene.asset)
    stranger = e.user("Stranger")
    assert e.client.post(f"/requests/{e.scene.req.id}/feedback-rounds/close", json={}, headers=e.headers(stranger)).status_code == 403


@needs_pg
def test_idle_close_honours_heartbeat_and_comments(scene):
    e = scene
    from apps.api.services import feedback_rounds
    comment(e, e.scene.asset)
    opened = rounds(e)[0]
    with e.Session() as db:
        assert feedback_rounds.close_idle(db, opened.opened_at + timedelta(minutes=4)) == 0
    assert e.client.post(f"/requests/{e.scene.req.id}/heartbeat", headers=e.headers(e.owner)).status_code == 204
    with e.Session() as db:
        beat = datetime.now(timezone.utc)
        assert feedback_rounds.close_idle(db, beat + timedelta(minutes=4)) == 0
        assert feedback_rounds.close_idle(db, beat + timedelta(minutes=6)) == 1
    [r] = rounds(e)
    assert r.closed_by == "idle" and r.closed_at is not None


@needs_pg
def test_close_collects_rule_suggestions_and_accept_forwards_to_the_rules_import(scene):
    e = scene
    comment(e, e.scene.asset, "Hook too slow here", 3.2)
    comment(e, e.scene.asset, "Always end on the product shot", None)
    e.client.post(f"/requests/{e.scene.req.id}/feedback-rounds/close", json={}, headers=e.headers(e.owner))
    rid = rounds(e)[0].id
    got = e.client.get(f"/feedback-rounds/{rid}/rule-suggestions", headers=e.headers(e.owner)).json()
    assert [(g["text"], g["scope"]) for g in got] == [("Always end on the product shot", "standing"), ("Hook too slow here", "scene")]
    assert got[0]["comment_id"]
    url = f"/feedback-rounds/{rid}/rule-suggestions/{got[0]['suggestion_id']}/accept"
    with patch("apps.api.services.review_bridge.import_rules", return_value=None):
        assert e.client.post(url, headers=e.headers(e.owner)).status_code == 503
    with patch("apps.api.services.review_bridge.import_rules", return_value={"ok": True}) as imp:
        assert e.client.post(url, headers=e.headers(e.owner)).status_code == 204
        assert e.client.post(url, headers=e.headers(e.owner)).status_code == 204  # idempotent, forwarded once
    assert imp.call_count == 1 and imp.call_args.args[1] == "Always end on the product shot"
    assert [g["text"] for g in e.client.get(f"/feedback-rounds/{rid}/rule-suggestions", headers=e.headers(e.owner)).json()] == ["Hook too slow here"]
    stranger = e.user("Stranger")
    assert e.client.get(f"/feedback-rounds/{rid}/rule-suggestions", headers=e.headers(stranger)).status_code == 403


@needs_pg
def test_agent_polls_with_cursor_and_acks_idempotently(scene):
    e = scene
    agent = e.scene.agent
    assert e.client.get("/agent/feedback", headers=agent.headers).json() == {"rounds": [], "next_cursor": None}
    comment(e, e.scene.asset)
    assert e.client.get("/agent/feedback", headers=agent.headers).json()["rounds"] == []  # still open
    e.client.post(f"/requests/{e.scene.req.id}/feedback-rounds/close", json={}, headers=e.headers(e.owner))
    got = e.client.get("/agent/feedback", headers=agent.headers).json()
    [rnd] = got["rounds"]
    assert rnd["schema"] == "feedback.v1" and got["next_cursor"] == rnd["closed_at"]
    # at-least-once: delivered again until acked
    assert len(e.client.get("/agent/feedback", headers=agent.headers).json()["rounds"]) == 1
    assert e.client.get("/agent/feedback", params={"cursor": got["next_cursor"]}, headers=agent.headers).json()["rounds"] == []
    assert e.client.post(f"/agent/feedback/{rnd['round_id']}/ack", headers=agent.headers).status_code == 204
    assert e.client.post(f"/agent/feedback/{rnd['round_id']}/ack", headers=agent.headers).status_code == 204
    assert e.client.get("/agent/feedback", headers=agent.headers).json()["rounds"] == []


@needs_pg
def test_other_agents_and_other_projects_never_see_a_round(scene):
    e = scene
    comment(e, e.scene.asset)
    e.client.post(f"/requests/{e.scene.req.id}/feedback-rounds/close", json={}, headers=e.headers(e.owner))
    rid = rounds(e)[0].id
    sibling = e.pair_agent(e.project_a, "Other")             # same project, did not hand in
    foreign = e.pair_agent(e.project_b, "Cutter")
    for who in (sibling, foreign):
        assert e.client.get("/agent/feedback", headers=who.headers).json()["rounds"] == []
        assert e.client.post(f"/agent/feedback/{rid}/ack", headers=who.headers).status_code == 404


@needs_pg
def test_request_agents_lists_only_live_agents_that_handed_in(scene):
    e = scene
    url = f"/requests/{e.scene.req.id}/agents"
    assert e.client.get(url, headers=e.headers(e.owner)).json() == [
        {"user_id": e.scene.agent.user_id, "name": "Cutter (codex)", "program": "codex"}]
    assert e.client.get(f"/requests/{e.request(e.project_a, e.owner).id}/agents", headers=e.headers(e.owner)).json() == []
    e.client.delete(f"/projects/{e.project_a.id}/agents/{e.scene.agent.user_id}", headers=e.headers(e.owner))
    assert e.client.get(url, headers=e.headers(e.owner)).json() == []


@needs_pg
def test_a_closed_round_is_never_closed_again(scene):
    e = scene
    from apps.api.services import feedback_rounds
    comment(e, e.scene.asset, "Always end on the product shot", None)
    e.client.post(f"/requests/{e.scene.req.id}/feedback-rounds/close", json={}, headers=e.headers(e.owner))
    rid = rounds(e)[0].id
    [sug] = e.client.get(f"/feedback-rounds/{rid}/rule-suggestions", headers=e.headers(e.owner)).json()
    with patch("apps.api.services.review_bridge.import_rules", return_value={"ok": True}):
        e.client.post(f"/feedback-rounds/{rid}/rule-suggestions/{sug['suggestion_id']}/accept", headers=e.headers(e.owner))
    before = rounds(e)[0]
    with e.Session() as db:
        assert feedback_rounds.close_idle(db, before.closed_at + timedelta(hours=1)) == 0
        feedback_rounds.close_round(db, db.get(type(before), rid), "idle", before.closed_at + timedelta(hours=2))
    after = rounds(e)[0]
    assert (after.closed_at, after.closed_by, after.rule_suggestions) == (before.closed_at, "button", before.rule_suggestions)
    assert after.rule_suggestions[0]["accepted"] is True


@needs_pg
def test_the_database_allows_one_open_round_and_a_racing_comment_joins_it(scene):
    e = scene
    from sqlalchemy.exc import IntegrityError
    from apps.api.models.agent import FeedbackRound
    from apps.api.services import feedback_rounds
    first = comment(e, e.scene.asset)
    with e.Session() as db:
        db.add(FeedbackRound(request_id=e.scene.req.id))
        with pytest.raises(IntegrityError):
            db.commit()
    # the race: the second comment looked, saw no open round (stale), then tried to insert one
    real = feedback_rounds.open_round
    seen = []
    def stale_then_real(db, request_id, **kw):
        seen.append(1)
        return None if len(seen) == 1 else real(db, request_id, **kw)
    with patch.object(feedback_rounds, "open_round", stale_then_real), e.Session() as db:
        feedback_rounds.on_comment(db, uuid.UUID(first["id"]))
    assert len(rounds(e)) == 1
