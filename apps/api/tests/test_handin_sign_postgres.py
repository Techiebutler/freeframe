"""V3 part C: the agent prepares a hand-in, only a signed-in staff member signs it, the client gets the clean link.

Veda (2026-11-16/17) took three tries to deliver; Patryk handed in by hand because no agent may sign anything.
"""
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

import base64
import struct
import zlib
from unittest.mock import patch

import pytest

from .agent_pg import env, needs_pg  # noqa: F401

pytestmark = needs_pg

RULES = {"rules": [{"id": "r2", "name": "Music under every ad", "what": "Light rhythmic music, no vocals.", "severity": "polish", "active": True},
                   {"id": "r1", "name": "No mirrored text", "what": "Flip a selfie source before export.", "severity": "blocker", "active": True},
                   {"id": "r3", "name": "Old rule", "what": "x", "severity": "blocker", "active": False}]}


def png(w=24, h=12):
    """A real PNG, the shape the initials canvas sends."""
    row = b"\x00" + b"\xff\xff\xff\xff" * w
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)  # noqa: E731
    raw = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(row * h)) + chunk(b"IEND", b"")
    return "data:image/png;base64," + base64.b64encode(raw).decode()


SIGN = {"accepted": True, "initials_png": png()}


@pytest.fixture(autouse=True)
def rules():
    with patch("apps.api.services.review_bridge.rules", return_value=RULES):
        yield


def staff(e):
    from apps.api.models.user import User
    with e.Session() as db:
        u = User(email=f"alan-{uuid.uuid4().hex[:6]}@aditor.ai", name="Alan")
        db.add(u)
        db.commit()
        return u


def prepared(e, n=2):
    agent = e.pair_agent(e.project_a)
    req = e.request(e.project_a, e.owner, "Veda Black Friday UGC 3")
    assets = [e.asset(req, f"Hook {i + 1}") for i in range(n)]
    r = e.client.post("/agent/handins", headers=agent.headers,
                      json={"request_id": str(req.id), "asset_ids": [str(a.id) for a in assets], "client_text": "Here are your 5 videos."})
    assert r.status_code == 200, r.text
    body = r.json()
    return agent, req, assets, body, parse_qs(urlparse(body["sign_url"]).query)["t"][0]


def test_prepare_then_staff_signs_once_and_the_client_link_shows_exactly_those_files(env):
    agent, req, assets, body, t = prepared(env)
    assert body["state"] == "prepared" and body["sign_url"].endswith(f"/handin/{body['id']}?t={t}")
    h = env.headers(staff(env))
    page = env.client.get(f"/handins/{body['id']}", params={"t": t}, headers=h).json()
    assert (page["state"], page["recipient"], page["client_text"], len(page["files"])) == ("prepared", "Brand A", "Here are your 5 videos.", 2)
    signed = env.client.post(f"/handins/{body['id']}/sign", params={"t": t}, headers=h, json=SIGN).json()
    assert signed["state"] == "signed" and signed["signed_by"] == "Alan" and signed["signed_at"]
    token = signed["client_url"].rsplit("/", 1)[1]
    listed = env.client.get(f"/share/{token}/assets").json()["assets"]  # anonymous = the client
    assert sorted(a["id"] for a in listed) == sorted(str(a.id) for a in assets)
    again = env.client.post(f"/handins/{body['id']}/sign", params={"t": t}, headers=h, json=SIGN).json()
    assert again["client_url"] == signed["client_url"]  # no second delivery
    from apps.api.models.share import ShareLink
    with env.Session() as db:
        assert db.query(ShareLink).filter(ShareLink.token == token).count() == 1


def test_preparing_the_same_files_again_is_the_same_handin_and_replaces_the_link(env):
    agent, req, assets, body, t = prepared(env)
    r = env.client.post("/agent/handins", headers=agent.headers, json={"request_id": str(req.id), "asset_ids": [str(a.id) for a in reversed(assets)]})
    assert r.json()["id"] == body["id"]
    t2 = parse_qs(urlparse(r.json()["sign_url"]).query)["t"][0]
    h = env.headers(staff(env))
    assert env.client.get(f"/handins/{body['id']}", params={"t": t}, headers=h).json()["detail"] == "link_replaced"
    assert env.client.get(f"/handins/{body['id']}", params={"t": t2}, headers=h).status_code == 200


def test_agents_clients_and_strangers_never_sign(env):
    agent, req, assets, body, t = prepared(env)
    agent_user = env.headers(agent.who)
    for headers, code, detail in ((agent.headers, 403, "agents_may_not_sign"), (agent_user, 403, "agents_may_not_sign"),
                                  (env.headers(env.user("Stephan")), 403, "staff_only"), ({}, 401, "sign_in")):
        r = env.client.post(f"/handins/{body['id']}/sign", params={"t": t}, headers=headers, json=SIGN)
        assert (r.status_code, r.json()["detail"]) == (code, detail)
    from apps.api.models.handin_sign import HandinSign
    with env.Session() as db:
        assert db.get(HandinSign, uuid.UUID(body["id"])).signed_at is None


def test_an_expired_link_says_so_and_signs_nothing(env):
    agent, req, assets, body, t = prepared(env)
    from apps.api.models.handin_sign import HandinSign
    with env.Session() as db:
        db.get(HandinSign, uuid.UUID(body["id"])).expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.commit()
    r = env.client.post(f"/handins/{body['id']}/sign", params={"t": t}, headers=env.headers(staff(env)), json=SIGN)
    assert (r.status_code, r.json()["detail"]) == (410, "link_expired")


def test_files_outside_the_request_are_refused(env):
    agent = env.pair_agent(env.project_a)
    mine, other = env.request(env.project_a, env.owner, "Mine"), env.request(env.project_a, env.owner, "Other")
    foreign = env.asset(other, "Hook 9")
    r = env.client.post("/agent/handins", headers=agent.headers, json={"request_id": str(mine.id), "asset_ids": [str(foreign.id)]})
    assert r.status_code == 404


def test_the_page_shows_the_brand_rules_blockers_first_and_only_active_ones(env):
    agent, req, assets, body, t = prepared(env)
    page = env.client.get(f"/handins/{body['id']}", params={"t": t}, headers=env.headers(staff(env))).json()
    assert [r["name"] for r in page["rules"]] == ["No mirrored text", "Music under every ad"]
    assert page["rules_reachable"] is True


def test_no_signature_without_the_box_ticked_and_drawn_initials(env):
    agent, req, assets, body, t = prepared(env)
    h = env.headers(staff(env))
    for payload, detail in (({"initials_png": png()}, "accept_terms"), ({"accepted": True}, "initials_required"),
                            ({"accepted": True, "initials_png": "data:image/png;base64,bm90IGEgcG5n"}, "initials_required"),
                            ({"accepted": True, "initials_png": "data:image/jpeg;base64," + png().split(",")[1]}, "initials_required")):
        r = env.client.post(f"/handins/{body['id']}/sign", params={"t": t}, headers=h, json=payload)
        assert (r.status_code, r.json()["detail"]) == (400, detail)
    from apps.api.models.handin_sign import HandinSign
    with env.Session() as db:
        assert db.get(HandinSign, uuid.UUID(body["id"])).signed_at is None


def test_the_initials_and_the_rules_shown_are_kept_with_the_signature(env):
    agent, req, assets, body, t = prepared(env)
    signed = env.client.post(f"/handins/{body['id']}/sign", params={"t": t}, headers=env.headers(staff(env)), json=SIGN).json()
    assert signed["initials_png"] == SIGN["initials_png"]
    from apps.api.models.handin_sign import HandinSign
    with env.Session() as db:
        row = db.get(HandinSign, uuid.UUID(body["id"]))
        assert row.initials_png == SIGN["initials_png"]
        assert [r["id"] for r in row.terms] == ["r1", "r2"]
