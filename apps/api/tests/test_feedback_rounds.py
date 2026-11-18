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
def test_a_drawn_frame_upload_is_the_frame_url_and_not_an_attachment(scene):
    e = scene
    from apps.api.models.comment import CommentAttachment
    drawn = comment(e, e.scene.asset, "Circle this", 3.2, annotation={"drawing_data": INK})
    plain = comment(e, e.scene.asset, "No ink", 4.0)
    with e.Session() as db:
        for cid, name in ((drawn["id"], "drawn-frame.jpg"), (drawn["id"], "ref.png"), (plain["id"], "ref2.png")):
            db.add(CommentAttachment(comment_id=uuid.UUID(cid), file_type="image/jpeg", s3_key=f"k/{cid}/{name}",
                                     original_filename=name, file_size_bytes=1, uploaded_at=T0))
        db.commit()
    url = lambda key, expires_in=0: f"https://s3/{key}"
    with patch("apps.api.services.s3_service.generate_presigned_get_url", side_effect=url):
        v1 = e.client.post(f"/requests/{e.scene.req.id}/feedback-rounds/close", json={"reason": "button"}, headers=e.headers(e.owner)).json()
    by_text = {n["text"]: n for n in v1["files"][0]["comments"]}
    d, p = by_text["Circle this"], by_text["No ink"]
    assert d["drawing"]["frame_url"] == f"https://s3/k/{drawn['id']}/drawn-frame.jpg"
    assert [a["file_name"] for a in d["attachments"]] == ["ref.png"]   # the drawn frame is not a reviewer image
    assert p["drawing"] is None and [a["file_name"] for a in p["attachments"]] == ["ref2.png"]


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
    assert e.client.get("/agent/feedback", headers=agent.headers).json() == {"rounds": [], "approvals": [], "next_cursor": None}
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


@needs_pg
def test_send_on_a_share_link_closes_the_round_at_once(scene):
    from .test_share_approve import link
    e = scene
    comment(e, e.scene.asset)
    url = f"/share/{link(e, e.scene.req.folder_id, 'comment')}/assets/{e.scene.asset.id}/feedback-done"
    assert e.client.post(url).status_code == 204
    [rnd] = rounds(e)
    assert rnd.closed_by == "button" and rnd.closed_at is not None
    assert e.client.post(url).status_code == 204  # nothing open: still fine
    view = f"/share/{link(e, e.scene.req.folder_id, 'view')}/assets/{e.scene.asset.id}/feedback-done"
    assert e.client.post(view).status_code == 403


# ── Agent-readable feedback (spec 2026-11-18): segments, mark ids, additive contract ──────────────────────────────

def _w(text, start, end):
    return {"w": text, "start_s": start, "end_s": end}


# The BOF case: "make this ..." then, after a pause, "as likeable as possible" at 6.1 s; the stroke began at 6.9 s (offset_ms)
# and sits on video frame 7.67. The fragment is a video-time 7.7 note, the drawn comment is stamped 12.4.
BOF_WORDS = [_w("Make", 0.2, 0.5), _w("this", 0.5, 0.8), _w("pop.", 0.8, 1.2),
             _w("as", 6.1, 6.24), _w("likeable", 6.3, 6.9), _w("as", 6.9, 7.0), _w("possible", 7.0, 7.6)]
BOF_MARKS = [{"k": "stroke", "t": 7.67, "offset_ms": 6900, "times": [0, 40], "points": [[0.4, 0.4], [0.6, 0.6]]}]


def test_segments_for_maps_the_bof_stroke_to_the_words_said_when_it_began():
    from apps.api.services.feedback_rounds import segments_for
    segs = segments_for(BOF_WORDS, BOF_MARKS)
    assert [(s["text"], s["start_s"], s["mark_ids"]) for s in segs] == [("Make this pop.", 0.2, []), ("as likeable as possible", 6.1, ["m0"])]


def test_segments_for_uses_the_stored_segments_and_their_video_time_and_assigns_marks_by_start():
    from apps.api.services.feedback_rounds import segments_for
    stored = [{"text": "Make this pop.", "start_s": 0.2, "end_s": 1.2, "video_t": 4.0, "segment_index": 0},
              {"text": "as likeable as possible", "start_s": 6.1, "end_s": 7.6, "video_t": 7.7, "segment_index": 1}]
    marks = [{"offset_ms": 100, "points": [[0, 0]]}, {"offset_ms": 6900, "points": [[0, 0]]}, {"offset_ms": 6200, "points": [[0, 0]]}]
    out = segments_for([], marks, stored)
    assert [(s["video_t"], s["mark_ids"]) for s in out] == [(4.0, ["m0"]), (7.7, ["m1", "m2"])]   # a stroke before the first word joins the first segment
    assert "mark_ids" not in stored[0]   # the stored list is not mutated


def test_segments_for_without_words_or_marks_is_empty_not_an_error():
    from apps.api.services.feedback_rounds import segments_for
    assert segments_for([], []) == [] and segments_for(BOF_WORDS, []) [0]["mark_ids"] == []


def test_a_long_pause_ends_a_sentence_even_without_punctuation():
    from apps.api.services.feedback_rounds import segments_for
    segs = segments_for([_w("slower", 0, 1), _w("and", 3, 3.2), _w("louder", 3.2, 4)], [])
    assert [s["text"] for s in segs] == ["slower", "and louder"]


def test_mark_ids_are_added_to_a_copy_and_old_marks_keep_their_fields():
    from apps.api.services.feedback_rounds import with_mark_ids
    out = with_mark_ids(INK)
    assert out["marks"][0]["mark_id"] == "m0" and out["marks"][0]["points"] == INK["marks"][0]["points"] and "mark_id" not in INK["marks"][0]
    assert with_mark_ids(None) is None


def test_dictations_key_appears_only_when_the_round_has_spoken_notes():
    from apps.api.services.feedback_rounds import build_feedback_v1
    kw = dict(round_id=uuid.uuid4(), request_id=uuid.uuid4(), project_id=uuid.uuid4(), briefing="b", opened_at=T0, closed_at=T0,
              closed_by="idle", context_base="https://x", files=[])
    assert "dictations" not in build_feedback_v1(**kw)
    assert build_feedback_v1(**kw, dictations=[{"dictation_id": "d"}])["dictations"] == [{"dictation_id": "d"}]


def test_attachment_kinds_audio_is_allowed_only_for_a_dictation_and_has_its_own_cap():
    from apps.api.services import comment_attachments as ca
    assert ca.check_file("audio/webm;codecs=opus", 1000, "dictation_audio") is None
    assert ca.check_file("audio/mp4", 1000, "dictation_audio") is None and ca.check_file("audio/ogg", 1, "dictation_audio") is None
    assert ca.check_file("audio/webm", 1000) is not None   # a reference image cannot be audio
    assert ca.check_file("image/png", 1000, "dictation_audio") is not None
    assert ca.check_file("audio/webm", ca.MAX_AUDIO_BYTES + 1, "dictation_audio") is not None
    assert ca.check_file("image/png", 1000) is None   # unchanged for images
