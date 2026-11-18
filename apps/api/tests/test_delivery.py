"""Approval -> delivery: the page, delivery.v1, the agent's approval event, take-back and hand-on."""
import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest

from .agent_pg import env, needs_pg  # noqa: F401

pytestmark = needs_pg


@pytest.fixture(autouse=True)
def settled(monkeypatch):
    monkeypatch.setattr("apps.api.services.deliveries.SETTLE", timedelta(0))


def approve(e, a, version=None):
    r = e.client.post(f"/assets/{a.id}/approve", json={"version_id": str(version or a.versions[0].id)}, headers=e.headers(e.owner))
    assert r.status_code == 200, r.text
    return r.json()["delivery"]


def media(e, a):
    from apps.api.models.asset import FileType, MediaFile
    with e.Session() as db:
        m = MediaFile(version_id=a.versions[0].id, file_type=FileType.video, original_filename="hook1.mp4", mime_type="video/mp4",
                      file_size_bytes=10, s3_key_raw=f"raw/{uuid.uuid4().hex}.mp4")
        db.add(m)
        db.commit()
        return m


def events(e, agent, cursor=""):
    return e.client.get("/agent/feedback", params={"cursor": cursor}, headers=agent.headers).json()


def test_approve_creates_one_delivery_and_the_agent_hears_of_it(env):
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner)
    a = env.asset(req, "Hook 1", by=agent.who)
    d = approve(env, a)
    assert approve(env, a)["token"] == d["token"]            # a repeat is the same delivery
    body = events(env, agent)
    [ev] = body["approvals"]
    assert (ev["type"], ev["request_id"], ev["asset_id"], ev["version_id"], ev["share_url"]) == (
        "approved", str(req.id), str(a.id), str(a.versions[0].id), d["share_url"])
    assert ev["approved_at"]
    assert events(env, agent, body["next_cursor"])["approvals"] == []   # past the cursor: nothing new
    assert [e["version_id"] for e in events(env, agent)["approvals"]] == [str(a.versions[0].id)]  # no cursor: still not handed on


def test_a_take_back_before_the_link_is_copied_leaves_no_delivery(env):
    agent = env.pair_agent(env.project_a)
    a = env.asset(env.request(env.project_a, env.owner), "Hook 1", by=agent.who)
    d = approve(env, a)
    assert env.client.delete(f"/assets/{a.id}/approve?version_id={a.versions[0].id}", headers=env.headers(env.owner)).status_code == 204
    assert events(env, agent)["approvals"] == []
    assert env.client.get(f"/deliveries/{d['token']}").status_code == 404


def test_copying_the_link_hands_on_and_survives_a_late_undo(env):
    agent = env.pair_agent(env.project_a)
    a = env.asset(env.request(env.project_a, env.owner), "Hook 1", by=agent.who)
    d = approve(env, a)
    assert env.client.post(f"/deliveries/{d['token']}/handed-on").status_code == 204
    assert env.client.post(f"/deliveries/{d['token']}/handed-on").status_code == 204
    assert env.client.delete(f"/assets/{a.id}/approve?version_id={a.versions[0].id}", headers=env.headers(env.owner)).status_code == 204
    assert events(env, agent)["approvals"] == []                       # handed on: not offered without a cursor
    assert len(events(env, agent, "2000-01-01T00:00:00+00:00")["approvals"]) == 1
    with patch("apps.api.services.review_bridge.asset_stats", return_value={}), patch("apps.api.services.review_bridge.request_status", return_value={}):
        [row] = env.client.get("/requests", headers=env.headers(env.owner)).json()
    assert row["delivered_at"]


def test_an_approval_is_not_announced_inside_the_undo_window(env, monkeypatch):
    monkeypatch.setattr("apps.api.services.deliveries.SETTLE", timedelta(seconds=60))
    agent = env.pair_agent(env.project_a)
    approve(env, env.asset(env.request(env.project_a, env.owner), "Hook 1", by=agent.who))
    assert events(env, agent)["approvals"] == []


def test_another_agents_key_never_sees_the_approval(env):
    mine, other = env.pair_agent(env.project_a), env.pair_agent(env.project_b, "Other")
    approve(env, env.asset(env.request(env.project_a, env.owner), "Hook 1", by=mine.who))
    assert len(events(env, mine)["approvals"]) == 1
    assert events(env, other)["approvals"] == []
    second = env.pair_agent(env.project_a, "Second")                    # same project, never handed a version in
    assert events(env, second)["approvals"] == []


def test_the_public_page_and_delivery_v1(env):
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner, "Hook 1")
    a = env.asset(req, "Hook 1", by=agent.who)
    m = media(env, a)
    d = approve(env, a)
    token = d["token"]
    with patch("apps.api.services.s3_service.generate_presigned_get_url", return_value="https://s3.test/raw.mp4"), \
         patch("apps.api.services.deliveries.sha256_of", return_value="ab" * 32):
        page = env.client.get(f"/deliveries/{token}").json()               # no login
        assert page["files"][0]["sha256"] is None                        # the page never hashes
        v1 = env.client.get(f"/deliveries/{token}?format=json").json()
        again = env.client.get(f"/deliveries/{token}?format=json").json()
    assert (v1["schema"], v1["title"], v1["brand"], v1["version"], v1["approved_by"], v1["video_url"]) == (
        "delivery.v1", "Hook 1", "Brand A", 1, "Owner", "https://s3.test/raw.mp4")
    assert v1["files"][0]["sha256"] == "ab" * 32 and again["files"][0]["sha256"] == "ab" * 32
    assert v1["files"][0]["url"].endswith(f"/deliveries/{token}/files/{m.id}") and len(v1["live_notes"]) == 3
    with patch("apps.api.services.s3_service.generate_presigned_get_url", return_value="https://s3.test/dl"):
        r = env.client.get(f"/deliveries/{token}/files/{m.id}", follow_redirects=False)
        assert (r.status_code, r.headers["location"]) == (302, "https://s3.test/dl")
        assert env.client.get(f"/deliveries/{token}/files/{uuid.uuid4()}", follow_redirects=False).status_code == 404
    assert env.client.get("/deliveries/nope").status_code == 404


# --- parts: no delivery / share link / approved event until EVERY part of the request is approved (founder, 2026-11-18) ---

def _hand_in(e, agent, names=("Hook 1", "Hook 2", "Body")):
    req = e.request(e.project_a, e.owner, "Ad")
    return req, [e.asset(req, n, by=agent.who) for n in names]


def _approve_raw(e, a):
    r = e.client.post(f"/assets/{a.id}/approve", json={"version_id": str(a.versions[0].id)}, headers=e.headers(e.owner))
    assert r.status_code == 200, r.text
    return r.json()


def test_one_part_approved_makes_no_delivery_and_no_agent_event(env):
    agent = env.pair_agent(env.project_a)
    _, (h1, h2, body) = _hand_in(env, agent)
    r = _approve_raw(env, h1)
    assert r["delivery"] is None and (r["parts"]["approved"], r["parts"]["total"], r["parts"]["complete"]) == (1, 3, False)
    assert events(env, agent)["approvals"] == []
    _approve_raw(env, h2)
    assert events(env, agent)["approvals"] == []


def test_the_last_part_delivers_every_part_at_once(env):
    agent = env.pair_agent(env.project_a)
    req, parts = _hand_in(env, agent)
    for a in parts[:-1]:
        _approve_raw(env, a)
    last = _approve_raw(env, parts[-1])
    assert last["delivery"]["share_url"] and last["parts"]["complete"] is True
    evs = events(env, agent)["approvals"]
    assert {e["asset_id"] for e in evs} == {str(a.id) for a in parts} and {e["request_id"] for e in evs} == {str(req.id)}


def test_a_take_back_while_parts_are_open_removes_the_unsent_links(env):
    agent = env.pair_agent(env.project_a)
    _, parts = _hand_in(env, agent, ("Hook 1", "Body"))
    for a in parts:
        d = _approve_raw(env, a)["delivery"]
    assert env.client.get(f"/deliveries/{d['token']}").status_code == 200
    assert env.client.delete(f"/assets/{parts[0].id}/approve?version_id={parts[0].versions[0].id}", headers=env.headers(env.owner)).status_code == 204
    assert env.client.get(f"/deliveries/{d['token']}").status_code == 404
    assert events(env, agent)["approvals"] == []


def test_a_handed_on_link_survives_a_later_undo_and_stays_in_the_events(env):
    agent = env.pair_agent(env.project_a)
    _, parts = _hand_in(env, agent, ("Hook 1", "Body"))
    for a in parts:
        d = _approve_raw(env, a)["delivery"]
    assert env.client.post(f"/deliveries/{d['token']}/handed-on").status_code == 204
    env.client.delete(f"/assets/{parts[1].id}/approve?version_id={parts[1].versions[0].id}", headers=env.headers(env.owner))
    assert env.client.get(f"/deliveries/{d['token']}").status_code == 200
    assert [e["asset_id"] for e in events(env, agent, "2000-01-01T00:00:00+00:00")["approvals"]] == [str(parts[1].id)]


def test_the_delivery_page_answers_409_while_parts_are_open(env):
    from apps.api.models.delivery import Delivery
    agent = env.pair_agent(env.project_a)
    req, parts = _hand_in(env, agent, ("Hook 1", "Body"))
    _approve_raw(env, parts[0])
    with env.Session() as db:   # a stray unsent link on a request that is not complete
        db.add(Delivery(token="stray", request_id=req.id, asset_id=parts[0].id, version_id=parts[0].versions[0].id,
                        approved_by="x", approved_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc)))
        db.commit()
    r = env.client.get("/deliveries/stray")
    assert r.status_code == 409 and r.json()["detail"] == {"error": "parts_open", "approved": 1, "total": 2}


def test_a_guest_approve_through_the_share_link_reports_progress_not_a_link(env):
    from .test_share_approve import link
    agent = env.pair_agent(env.project_a)
    req, (h1, h2) = _hand_in(env, agent, ("Hook 1", "Hook 2"))
    r = env.client.post(f"/share/{link(env, req.folder_id)}/assets/{h1.id}/approve", json={}).json()
    assert r["delivery"] is None and (r["parts"]["approved"], r["parts"]["total"]) == (1, 2)
