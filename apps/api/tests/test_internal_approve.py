"""POST /internal/assets/{id}/approve: the owner's ADI "Approve anyway" becomes their approval (bridge secret only)."""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from apps.api.config import settings
from apps.api.main import app
from .agent_pg import env, needs_pg  # noqa: F401

SECRET = "s3cret"


def url(a):
    return f"/internal/assets/{a}/approve"


def body(e, a, **kw):
    return {"version_id": str(a.versions[-1].id), "decided_by": e.owner.email, "decided_via": "adi", "decision_id": "adi-42", **kw}


def hdr(secret=SECRET):
    return {"Authorization": f"Bearer {secret}"}


@pytest.fixture(autouse=True)
def bridge(monkeypatch):
    monkeypatch.setattr(settings, "review_bridge_secret", SECRET)
    monkeypatch.setattr("apps.api.services.deliveries.SETTLE", timedelta(0))


def counts(e):
    from apps.api.models.activity import ActivityLog
    from apps.api.models.approval import Approval
    with e.Session() as db:
        return db.query(Approval).filter(Approval.deleted_at.is_(None)).count(), db.query(ActivityLog).filter_by(action="approved").count()


def test_secret_gate(monkeypatch):
    c = TestClient(app)
    a = uuid.uuid4()
    assert c.post(url(a), json={}).status_code == 403
    assert c.post(url(a), json={}, headers=hdr("nope")).status_code == 403
    monkeypatch.setattr(settings, "review_bridge_secret", "")
    assert c.post(url(a), json={}, headers=hdr("")).status_code == 503


@needs_pg
def test_agent_key_is_not_the_bridge(env):
    agent = env.pair_agent(env.project_a)
    a = env.asset(env.request(env.project_a, env.owner), by=agent.who)
    assert env.client.post(url(a.id), json=body(env, a), headers=agent.headers).status_code == 403
    assert counts(env) == (0, 0)


@needs_pg
def test_invalid_body_is_422(env):
    a = env.asset(env.request(env.project_a, env.owner))
    for bad in ({"decided_via": "agent"}, {"decision_id": ""}, {"decision_id": "x" * 121}, {"version_id": "nope"}, {"decided_by": 5}):
        assert env.client.post(url(a.id), json=body(env, a, **bad), headers=hdr()).status_code == 422, bad
    assert counts(env) == (0, 0)


@needs_pg
def test_unknown_or_deleted_asset_is_404(env):
    from apps.api.models.asset import Asset
    a = env.asset(env.request(env.project_a, env.owner))
    r = env.client.post(url(uuid.uuid4()), json=body(env, a), headers=hdr())
    assert r.status_code == 404 and r.json()["detail"]["error"] == "not_found"
    with env.Session() as db:
        db.get(Asset, a.id).deleted_at = datetime.now(timezone.utc)
        db.commit()
    assert env.client.post(url(a.id), json=body(env, a), headers=hdr()).status_code == 404


@needs_pg
def test_not_the_owner_is_403_and_leaves_no_approval(env):
    a = env.asset(env.request(env.project_a, env.owner))
    other = env.user("Other")
    r = env.client.post(url(a.id), json=body(env, a, decided_by=other.email), headers=hdr())
    assert r.status_code == 403 and r.json()["detail"]["error"] == "not_owner"
    assert counts(env) == (0, 0)


@needs_pg
def test_owner_email_matches_case_insensitively(env):
    a = env.asset(env.request(env.project_a, env.owner))
    r = env.client.post(url(a.id), json=body(env, a, decided_by=f"  {env.owner.email.upper()} "), headers=hdr())
    assert r.status_code == 200, r.text


@needs_pg
def test_an_older_version_is_409_with_the_current_one(env):
    a = env.asset(env.request(env.project_a, env.owner), versions=2)
    r = env.client.post(url(a.id), json=body(env, a, version_id=str(a.versions[0].id)), headers=hdr())
    assert r.status_code == 409
    assert r.json()["detail"] == {"error": "version_moved", "current_version_id": str(a.versions[1].id)}
    assert counts(env) == (0, 0)


@needs_pg
def test_a_deleted_newest_version_does_not_count(env):
    from apps.api.models.asset import AssetVersion
    a = env.asset(env.request(env.project_a, env.owner), versions=2)
    with env.Session() as db:
        db.get(AssetVersion, a.versions[1].id).deleted_at = datetime.now(timezone.utc)
        db.commit()
    assert env.client.post(url(a.id), json=body(env, a, version_id=str(a.versions[1].id)), headers=hdr()).status_code == 409
    assert env.client.post(url(a.id), json=body(env, a, version_id=str(a.versions[0].id)), headers=hdr()).status_code == 200


@needs_pg
def test_happy_path_is_the_owners_approval_and_shows_in_the_queue(env):
    from apps.api.models.approval import Approval, ApprovalStatus
    from apps.api.services import agent_queue
    a = env.asset(env.request(env.project_a, env.owner), "Hook 1")
    r = env.client.post(url(a.id), json=body(env, a), headers=hdr())
    assert r.status_code == 200, r.text
    j = r.json()
    assert (j["asset_id"], j["version_id"], j["status"]) == (str(a.id), str(a.versions[0].id), "approved")
    assert j["delivery"]["share_url"] and (j["parts"]["approved"], j["parts"]["total"]) == (1, 1)
    with env.Session() as db:
        [ap] = db.query(Approval).all()
        assert (ap.user_id, ap.status, ap.note, ap.version_id) == (env.owner.id, ApprovalStatus.approved, "adi:adi-42", a.versions[0].id)
    assert counts(env)[1] == 1
    with patch("apps.api.services.review_bridge.asset_stats", return_value={}), patch("apps.api.services.review_bridge.request_status", return_value={}), env.Session() as db:
        [row] = agent_queue.queue(db, env.project_a.id)
    assert [x["approval"] for x in row["assets"]] == ["approved"]


@needs_pg
def test_the_last_part_delivers_and_parts_count_n_of_n(env):
    req = env.request(env.project_a, env.owner, "Ad")
    h1, body_ = env.asset(req, "Hook 1"), env.asset(req, "Body")
    r1 = env.client.post(url(h1.id), json=body(env, h1), headers=hdr()).json()
    assert r1["delivery"] is None and (r1["parts"]["approved"], r1["parts"]["total"], r1["parts"]["complete"]) == (1, 2, False)
    r2 = env.client.post(url(body_.id), json=body(env, body_), headers=hdr()).json()
    assert r2["delivery"]["share_url"] and (r2["parts"]["approved"], r2["parts"]["total"], r2["parts"]["complete"]) == (2, 2, True)


@needs_pg
def test_a_repeat_is_200_with_the_same_answer_and_no_second_rows(env):
    a = env.asset(env.request(env.project_a, env.owner))
    first = env.client.post(url(a.id), json=body(env, a), headers=hdr())
    again = env.client.post(url(a.id), json=body(env, a, decision_id="adi-43"), headers=hdr())
    assert first.status_code == again.status_code == 200
    assert first.json() == again.json()
    assert counts(env) == (1, 1)


@needs_pg
def test_an_earlier_human_approval_is_kept_untouched(env):
    from apps.api.models.approval import Approval
    a = env.asset(env.request(env.project_a, env.owner))
    assert env.client.post(f"/assets/{a.id}/approve", json={"version_id": str(a.versions[0].id)}, headers=env.headers(env.owner)).status_code == 200
    assert env.client.post(url(a.id), json=body(env, a), headers=hdr()).status_code == 200
    with env.Session() as db:
        [ap] = db.query(Approval).all()
        assert ap.note is None


@needs_pg
def test_a_human_round_afterwards_voids_it_like_a_persons(env):
    from apps.api.models.agent import FeedbackRound
    from apps.api.models.comment import Comment
    from apps.api.services import feedback_rounds
    agent = env.pair_agent(env.project_a)
    a = env.asset(env.request(env.project_a, env.owner), "Hook 1", by=agent.who)
    assert env.client.post(url(a.id), json=body(env, a), headers=hdr()).status_code == 200
    with env.Session() as db:
        db.add(Comment(asset_id=a.id, version_id=a.versions[0].id, author_id=env.owner.id, body="remake it", timecode_start=1.0))
        db.commit()
        c = db.query(Comment).filter_by(body="remake it").one()
        feedback_rounds.on_comment(db, c.id)
    with env.Session() as db:
        rnd = db.query(FeedbackRound).filter(FeedbackRound.closed_at.is_(None)).one()
        feedback_rounds.close_round(db, rnd, "button", datetime.now(timezone.utc) + timedelta(seconds=1))
    assert counts(env)[0] == 0
