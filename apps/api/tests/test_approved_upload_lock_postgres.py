"""PG: the approved-upload lock on every version-creating route, and a closed human round voiding the approval."""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from .agent_pg import env, needs_pg  # noqa: F401

pytestmark = needs_pg


@pytest.fixture(autouse=True)
def settled(monkeypatch):
    monkeypatch.setattr("apps.api.services.deliveries.SETTLE", timedelta(0))


def approve(e, a, version=None):
    r = e.client.post(f"/assets/{a.id}/approve", json={"version_id": str(version or a.versions[-1].id)}, headers=e.headers(e.owner))
    assert r.status_code == 200, r.text
    return r.json()["delivery"]


def body(**kw):
    return {"original_filename": "Hook 1.mp4", "mime_type": "video/mp4", "file_size_bytes": 1000, **kw}


def human_comment(e, a, version, text="remake it, looks too cheap"):
    from apps.api.models.comment import Comment
    with e.Session() as db:
        db.add(Comment(asset_id=a.id, version_id=version.id, author_id=e.owner.id, body=text, timecode_start=1.0))
        db.commit()
    with e.Session() as db:
        c = db.query(Comment).filter_by(body=text).first()
        from apps.api.services import feedback_rounds
        feedback_rounds.on_comment(db, c.id)


def versions(e, a):
    from apps.api.models.asset import AssetVersion
    with e.Session() as db:
        return db.query(AssetVersion).filter_by(asset_id=a.id).count()


def test_agent_upload_to_an_approved_asset_is_refused_with_409(env):
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner)
    a = env.asset(req, "Hook 1", by=agent.who)
    approve(env, a)
    with patch("apps.api.routers.requests.create_multipart_upload", return_value="uid"):
        r = env.client.post(f"/r/{req.token}/upload/initiate", json=body(asset_id=str(a.id)), headers=agent.headers)
    assert r.status_code == 409
    assert r.json() == {"error": "already_approved", "asset_id": str(a.id), "version_id": str(a.versions[0].id),
                        "hint": "pass reopen=true to start a new version anyway"}
    assert versions(env, a) == 1


def test_the_same_asset_by_name_is_locked_too(env):
    req = env.request(env.project_a, env.owner)
    a = env.asset(req, "Hook 1")
    approve(env, a)
    with patch("apps.api.routers.requests.create_multipart_upload", return_value="uid"):
        assert env.client.post(f"/r/{req.token}/upload/initiate", json=body()).status_code == 409


def test_reopen_starts_the_version_and_the_approval_stays_on_the_old_one(env):
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner)
    a = env.asset(req, "Hook 1", by=agent.who)
    approve(env, a)
    with patch("apps.api.routers.requests.create_multipart_upload", return_value="uid"):
        r = env.client.post(f"/r/{req.token}/upload/initiate", json=body(asset_id=str(a.id), reopen=True), headers=agent.headers)
    assert r.status_code == 200, r.text
    assert r.json()["version_number"] == 2
    from apps.api.models.approval import Approval
    with env.Session() as db:
        [row] = db.query(Approval).all()
    assert row.version_id == a.versions[0].id and row.status.value == "approved"
    # the newest version (v2) has no approval now: a further upload is allowed without reopen
    with patch("apps.api.routers.requests.create_multipart_upload", return_value="uid"):
        assert env.client.post(f"/r/{req.token}/upload/initiate", json=body(asset_id=str(a.id)), headers=agent.headers).status_code == 200


def test_signed_in_upload_routes_are_locked_too(env):
    req = env.request(env.project_a, env.owner)
    a = env.asset(req, "Hook 1")
    approve(env, a)
    h = env.headers(env.owner)
    with patch("apps.api.routers.assets.create_multipart_upload", return_value="uid"), patch("apps.api.routers.upload.create_multipart_upload", return_value="uid"):
        r1 = env.client.post(f"/assets/{a.id}/versions", json={"project_id": str(env.project_a.id), "asset_name": "Hook 1", **body()}, headers=h)
        r2 = env.client.post("/upload/initiate", json={"project_id": str(env.project_a.id), "asset_name": "Hook 1", "asset_id": str(a.id), **body()}, headers=h)
        assert (r1.status_code, r2.status_code) == (409, 409)
        assert env.client.post(f"/assets/{a.id}/versions", json={"project_id": str(env.project_a.id), "asset_name": "Hook 1", "reopen": True, **body()}, headers=h).status_code == 200


def test_a_new_upload_before_any_approval_is_never_locked(env):
    req = env.request(env.project_a, env.owner)
    a = env.asset(req, "Hook 1")
    with patch("apps.api.routers.requests.create_multipart_upload", return_value="uid"):
        assert env.client.post(f"/r/{req.token}/upload/initiate", json=body(asset_id=str(a.id))).status_code == 200


def test_a_human_round_on_the_approved_version_voids_the_approval_when_it_closes(env):
    from apps.api.models.agent import FeedbackRound
    from apps.api.models.approval import Approval
    from apps.api.services import feedback_rounds
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner)
    a = env.asset(req, "Hook 1", versions=2, by=agent.who)
    d = approve(env, a, a.versions[1].id)
    human_comment(env, a, a.versions[1])
    with env.Session() as db:   # comment alone changes nothing: the round is still open
        assert db.query(Approval).count() == 1
        rnd = db.query(FeedbackRound).filter(FeedbackRound.closed_at.is_(None)).one()
        feedback_rounds.close_round(db, rnd, "button", datetime.now(timezone.utc) + timedelta(seconds=1))
        assert db.query(Approval).count() == 0
    assert env.client.get(f"/deliveries/{d['token']}").status_code == 404          # unsent delivery removed
    with patch("apps.api.routers.requests.create_multipart_upload", return_value="uid"):   # and the lock is open
        assert env.client.post(f"/r/{req.token}/upload/initiate", json=body(asset_id=str(a.id)), headers=agent.headers).status_code == 200


def test_a_delivery_already_handed_on_survives_the_voiding(env):
    from apps.api.models.agent import FeedbackRound
    from apps.api.services import feedback_rounds
    req = env.request(env.project_a, env.owner)
    a = env.asset(req, "Hook 1")
    d = approve(env, a)
    assert env.client.post(f"/deliveries/{d['token']}/handed-on").status_code == 204
    human_comment(env, a, a.versions[0])
    with env.Session() as db:
        feedback_rounds.close_round(db, db.query(FeedbackRound).one(), "button", datetime.now(timezone.utc) + timedelta(seconds=1))
    assert env.client.get(f"/deliveries/{d['token']}").status_code == 200


def test_approving_after_the_comments_keeps_the_approval_when_the_round_closes(env):
    from apps.api.models.agent import FeedbackRound
    from apps.api.models.approval import Approval
    from apps.api.services import feedback_rounds
    req = env.request(env.project_a, env.owner)
    a = env.asset(req, "Hook 1")
    human_comment(env, a, a.versions[0], "fine, small thing")
    approve(env, a)
    with env.Session() as db:
        feedback_rounds.close_round(db, db.query(FeedbackRound).one(), "idle", datetime.now(timezone.utc) + timedelta(minutes=10))
        assert db.query(Approval).count() == 1


def test_agent_and_auto_review_comments_never_void(env):
    from apps.api.models.agent import FeedbackRound
    from apps.api.models.approval import Approval
    from apps.api.models.comment import Comment
    from apps.api.services import feedback_rounds
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner)
    a = env.asset(req, "Hook 1", by=agent.who)
    approve(env, a)
    with env.Session() as db:
        db.add(Comment(asset_id=a.id, version_id=a.versions[0].id, author_id=agent.who.id, body="agent note", timecode_start=1.0))
        db.commit()
        feedback_rounds.on_comment(db, db.query(Comment).first().id)
        assert db.query(FeedbackRound).count() == 0                 # an agent's comment does not even open a round
        assert db.query(Approval).count() == 1
