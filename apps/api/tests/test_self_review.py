"""Nachtrag 5: an agent files a card as V1 in AutoReview and fixes it in public view of the owner (Self-Review)."""
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from .agent_pg import env, needs_pg  # noqa: F401

T = datetime(2026, 11, 4, 10, 0, tzinfo=timezone.utc)


def a(state, latest_agent=True, agent_versions=1, at=0):
    return {"review_state": state, "latest_is_agent": latest_agent, "agent_versions": agent_versions, "latest_at": T + timedelta(minutes=at)}


# ── Pure ──────────────────────────────────────────────────────────────────────

def test_review_phase_follows_the_contract():
    from apps.api.services.review_phase import review_phase
    assert review_phase([]) is None
    assert review_phase([a("held")]) == "self_review"
    assert review_phase([a("reviewing")]) == "self_review"
    assert review_phase([a("clear"), a("held")]) == "self_review"
    assert review_phase([a("clear"), a("clear")]) == "ready_for_editor"
    assert review_phase([a("held", agent_versions=3)]) == "agent_stuck"
    assert review_phase([a("reviewing", agent_versions=3)]) == "self_review"       # third verdict not in yet
    assert review_phase([a("clear", agent_versions=4)]) == "ready_for_editor"


def test_a_human_newest_version_means_no_phase():
    from apps.api.services.review_phase import review_phase
    assert review_phase([a("clear", latest_agent=False)]) is None
    assert review_phase([a("clear", at=0), a("clear", latest_agent=False, at=5)]) is None
    assert review_phase([a("clear", latest_agent=False, at=0), a("held", at=5)]) == "self_review"


# ── Postgres ──────────────────────────────────────────────────────────────────

def make(e, agent, **body):
    return e.client.post("/agent/requests", json={"title": "Glow hook", "external_ref": "gen:abc", **body}, headers=agent.headers)


@needs_pg
def test_create_is_idempotent_per_project_and_external_ref(env):
    agent = env.pair_agent(env.project_a)
    with patch("apps.api.routers.requests.dispatch_binding") as dispatch:
        first = make(env, agent)
        assert first.status_code == 200, first.text
        again = make(env, agent, title="Renamed")
        other = make(env, agent, external_ref="gen:other")
    one, two, three = first.json(), again.json(), other.json()
    assert one["created"] is True and two["created"] is False and three["created"] is True
    assert two["request_id"] == one["request_id"] and two["folder_id"] == one["folder_id"] and two["upload_token"] == one["upload_token"]
    assert three["request_id"] != one["request_id"]
    assert dispatch.call_count == 2                       # registered with AutoReview once per new request
    from apps.api.models.upload_request import UploadRequest
    with env.Session() as db:
        row = db.get(UploadRequest, one["request_id"])
        assert (row.external_ref, str(row.created_by), row.title) == ("gen:abc", agent.user_id, "Glow hook")


@needs_pg
def test_same_ref_in_another_project_is_a_different_request(env):
    mine, theirs = env.pair_agent(env.project_a), env.pair_agent(env.project_b, "Other")
    with patch("apps.api.routers.requests.dispatch_binding"):
        assert make(env, mine).json()["request_id"] != make(env, theirs).json()["request_id"]


@needs_pg
def test_the_database_refuses_a_second_request_with_the_same_ref(env):
    import pytest
    from sqlalchemy.exc import IntegrityError
    req = env.request(env.project_a, env.owner)
    from apps.api.models.upload_request import UploadRequest
    with env.Session() as db:
        db.get(UploadRequest, req.id).external_ref = "gen:x"
        db.commit()
    other = env.request(env.project_a, env.owner, "Two")
    with env.Session() as db, pytest.raises(IntegrityError):
        db.get(UploadRequest, other.id).external_ref = "gen:x"
        db.commit()


@needs_pg
def test_agent_request_is_on_the_queue_with_a_phase_and_its_token_uploads(env):
    agent = env.pair_agent(env.project_a)
    with patch("apps.api.routers.requests.dispatch_binding"):
        made = make(env, agent).json()
    from apps.api.models.upload_request import UploadRequest
    with env.Session() as db:
        req = db.get(UploadRequest, made["request_id"])
    one = env.asset(req, "Hook 1", by=agent.who)
    def queue(state, must_fix=0):
        with patch("apps.api.services.review_bridge.asset_stats", return_value={str(one.id): {"version_id": str(one.versions[0].id), "reviewed": True, "openMustFix": must_fix}}), \
             patch("apps.api.services.review_bridge.request_status", return_value={req.review_share_token: {"status": state, "openMustFixes": must_fix}}):
            return env.client.get("/agent/queue", headers=agent.headers).json()
    [row] = queue("held", 2)
    assert row["request_id"] == made["request_id"] and row["upload_token"] == made["upload_token"] and row["review_phase"] == "self_review"
    assert queue("clear")[0]["review_phase"] == "ready_for_editor"


@needs_pg
def test_requests_list_exposes_review_phase_and_humans_get_null(env):
    agent = env.pair_agent(env.project_a)
    mine = env.request(env.project_a, env.owner, "By agent")
    theirs = env.request(env.project_a, env.owner, "By human")
    one, two = env.asset(mine, "Hook 1", by=agent.who), env.asset(theirs, "Hook 2")
    stats = {str(x.id): {"version_id": str(x.versions[0].id), "reviewed": True, "openMustFix": 1} for x in (one, two)}
    statuses = {r.review_share_token: {"status": "held", "openMustFixes": 1} for r in (mine, theirs)}
    with patch("apps.api.services.review_bridge.asset_stats", return_value=stats), \
         patch("apps.api.services.review_bridge.request_status", return_value=statuses):
        rows = env.client.get(f"/requests?project_id={env.project_a.id}", headers=env.headers(env.owner)).json()
    assert {r["title"]: r["review_phase"] for r in rows} == {"By agent": "self_review", "By human": None}


@needs_pg
def test_queue_has_processing_status_and_review_url_and_initiate_takes_an_asset_id(env):
    from apps.api.config import settings
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner)
    one = env.asset(req, "Hook 1", versions=2, by=agent.who, status="processing")
    with patch("apps.api.services.review_bridge.asset_stats", return_value={}), patch("apps.api.services.review_bridge.request_status", return_value={}):
        [row] = env.client.get("/agent/queue", headers=agent.headers).json()
    assert row["review_url"] == f"{settings.frontend_url.rstrip('/')}/share/{req.review_share_token}"
    assert row["assets"][0]["processing_status"] == "processing" and row["assets"][0]["version_number"] == 2
    with patch("apps.api.routers.requests.dispatch_binding"):
        made = env.client.post("/agent/requests", json={"title": "T", "external_ref": "gen:z"}, headers=agent.headers).json()
    assert made["review_url"].startswith(settings.frontend_url.rstrip("/") + "/share/")
    # a new version of an existing asset: asset_id in the request's own folder works, another folder is 404
    body = {"original_filename": "Hook 1.mp4", "mime_type": "video/mp4", "file_size_bytes": 1000, "asset_id": str(one.id)}
    with patch("apps.api.routers.requests.create_multipart_upload", return_value="uid"):
        ok = env.client.post(f"/r/{req.token}/upload/initiate", json=body, headers=agent.headers)
        assert ok.status_code == 200 and ok.json()["asset_id"] == str(one.id) and ok.json()["version_number"] == 3
        other = env.request(env.project_a, env.owner, "Elsewhere")
        assert env.client.post(f"/r/{other.token}/upload/initiate", json=body, headers=agent.headers).status_code == 404


@needs_pg
def test_agent_request_works_when_folders_must_carry_a_trello_link(env, monkeypatch):
    """The folder-link rule guards the /folders routes; a request creates its folder itself and never trips it."""
    from apps.api.config import settings
    monkeypatch.setattr(settings, "require_folder_description_pattern", r"trello\.com/c/")
    monkeypatch.setattr(settings, "require_project_description_pattern", r"trello\.com/c/")
    agent = env.pair_agent(env.project_a)
    with patch("apps.api.routers.requests.dispatch_binding"):
        r = env.client.post("/agent/requests", json={"title": "Glow hook", "external_ref": "gen:abc"}, headers=agent.headers)
    assert r.status_code == 200 and r.json()["created"] is True
    # the pattern really is on: a plain folder without a link is refused
    assert env.client.post(f"/projects/{env.project_a.id}/folders", json={"name": "x", "description": "no link"},
                           headers=env.headers(env.owner)).status_code == 400
