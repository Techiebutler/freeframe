"""P3: the owner hears about an agent hand-in only when it is clear (or the agent is stuck); editor ranking shows agents."""
from unittest.mock import patch

from .agent_pg import env, needs_pg  # noqa: F401


def a(asset_id, n, state, since=1):
    return {"asset_id": asset_id, "version_number": n, "review_state": state, "agent_versions_since_notice": since}


# ── Pure ──────────────────────────────────────────────────────────────────────

def test_nothing_is_sent_while_in_review_or_in_corrections():
    from apps.api.services.agent_notify import decide
    for state in ("reviewing", "held", "unavailable", "upload_incomplete"):
        assert decide([a("1", 1, state, 2)], None) is None
    assert decide([a("1", 1, "clear"), a("2", 1, "held")], None) is None   # one asset still open


def test_all_clear_sends_ready_once_per_version_set():
    from apps.api.services.agent_notify import decide
    assert decide([a("1", 2, "clear"), a("2", 1, "clear")], None) == {"event": "ready", "agent_stuck": False, "versions": {"1": 2, "2": 1}}
    assert decide([a("1", 2, "clear"), a("2", 1, "clear")], {"1": 2, "2": 1}) is None
    assert decide([a("1", 3, "clear"), a("2", 1, "clear")], {"1": 2, "2": 1})["event"] == "ready"   # a new version is news again


def test_three_agent_versions_without_clear_escalate_with_agent_stuck():
    from apps.api.services.agent_notify import decide
    assert decide([a("1", 2, "held", 2)], None) is None
    out = decide([a("1", 3, "held", 3)], None)
    assert out == {"event": "ready", "agent_stuck": True, "versions": {"1": 3}}
    assert decide([a("1", 3, "held", 3)], {"1": 3}) is None                # already escalated
    assert decide([a("1", 3, "reviewing", 3)], None) is None               # the third verdict is not in yet


# ── Postgres ──────────────────────────────────────────────────────────────────

def clear(version, n=0):
    return {"version_id": str(version.id), "reviewed": True, "openMustFix": n}


def logs(e):
    from apps.api.models.activity import ActivityLog
    with e.Session() as db:
        return db.query(ActivityLog).filter_by(action="agent_handin_ready").all()


def poll(e, agent, req, stats, status):
    with patch("apps.api.services.review_bridge.asset_stats", return_value=stats), \
         patch("apps.api.services.review_bridge.request_status", return_value={req.review_share_token: status}):
        r = e.client.get("/agent/queue", headers=agent.headers)
    assert r.status_code == 200, r.text
    return r.json()


@needs_pg
def test_owner_event_only_when_the_whole_request_is_clear(env):
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner, "Hook tests")
    one, two = env.asset(req, "Hook 1", by=agent.who), env.asset(req, "Hook 2", by=agent.who)
    held = {str(one.id): clear(one.versions[0], 1), str(two.id): clear(two.versions[0])}
    poll(env, agent, req, held, {"status": "held", "openMustFixes": 1})
    assert logs(env) == []
    ok = {str(one.id): clear(one.versions[0]), str(two.id): clear(two.versions[0])}
    poll(env, agent, req, ok, {"status": "clear", "openMustFixes": 0})
    [row] = logs(env)
    assert row.payload["event"] == "ready" and row.payload["agent_stuck"] is False and row.payload["request_id"] == str(req.id)
    assert str(row.user_id) == agent.user_id and row.project_id == env.project_a.id
    poll(env, agent, req, ok, {"status": "clear", "openMustFixes": 0})      # polling again does not repeat it
    assert len(logs(env)) == 1


@needs_pg
def test_a_human_hand_in_never_creates_an_agent_event(env):
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner)
    one = env.asset(req, "Hook 1")                                         # handed in by a@example.test, a person
    poll(env, agent, req, {str(one.id): clear(one.versions[0])}, {"status": "clear", "openMustFixes": 0})
    assert logs(env) == []


@needs_pg
def test_stuck_agent_escalates_after_three_versions(env):
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner)
    one = env.asset(req, "Hook 1", versions=3, by=agent.who)
    poll(env, agent, req, {str(one.id): clear(one.versions[2], 2)}, {"status": "held", "openMustFixes": 2})
    [row] = logs(env)
    assert row.payload["agent_stuck"] is True and row.payload["versions"] == {str(one.id): 3}


@needs_pg
def test_sweep_notifies_when_the_agent_stopped_polling(env):
    from datetime import datetime, timezone
    from apps.api.services import agent_notify
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner)
    one = env.asset(req, "Hook 1", by=agent.who)
    with patch("apps.api.services.review_bridge.asset_stats", return_value={str(one.id): clear(one.versions[0])}), \
         patch("apps.api.services.review_bridge.request_status", return_value={req.review_share_token: {"status": "clear", "openMustFixes": 0}}):
        with env.Session() as db:
            assert agent_notify.sweep(db, datetime.now(timezone.utc)) == 1
            assert agent_notify.sweep(db, datetime.now(timezone.utc)) == 0
    assert len(logs(env)) == 1


@needs_pg
def test_editor_ranking_labels_agents_with_kind_and_program(env):
    agent = env.pair_agent(env.project_a, "Cutter", "hermes")
    req = env.request(env.project_a, env.owner)
    env.asset(req, "Hook 1", by=agent.who)
    env.asset(req, "Hook 2")
    with patch("apps.api.services.review_bridge.asset_stats", return_value={}):
        rows = env.client.get("/insights/editors", headers=env.headers(env.owner)).json()["editors"]
    by = {r["email"]: r for r in rows}
    assert (by[agent.who.email]["kind"], by[agent.who.email]["program"]) == ("agent", "hermes")
    assert (by["a@example.test"]["kind"], by["a@example.test"]["program"]) == ("human", None)


@needs_pg
def test_one_event_per_clear_transition_not_per_poll(env):
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner)
    one = env.asset(req, "Hook 1", versions=2, by=agent.who)
    v1, v2 = one.versions
    clear_status, held_status = {"status": "clear", "openMustFixes": 0}, {"status": "held", "openMustFixes": 1}
    for _ in range(3):
        poll(env, agent, req, {str(one.id): clear(v2)}, clear_status)
    assert len(logs(env)) == 1                                              # polling never repeats it
    poll(env, agent, req, {str(one.id): clear(v2, 1)}, held_status)         # clear -> held -> clear on the SAME version
    poll(env, agent, req, {str(one.id): clear(v2)}, clear_status)
    assert len(logs(env)) == 1
    from apps.api.models.asset import AssetVersion
    from apps.api.models.upload_request import RequestUpload
    from datetime import datetime, timezone
    with env.Session() as db:                                               # a genuinely new version is new news
        v3 = AssetVersion(asset_id=one.id, version_number=3, processing_status=v2.processing_status, created_by=req.created_by)
        db.add(v3)
        db.flush()
        db.add(RequestUpload(request_id=req.id, asset_id=one.id, version_number=3, uploader_name=agent.who.name,
                             uploader_email=agent.who.email, submitted_at=datetime.now(timezone.utc)))
        db.commit()
        v3_id = v3.id
    poll(env, agent, req, {str(one.id): {"version_id": str(v3_id), "reviewed": True, "openMustFix": 0}}, clear_status)
    assert len(logs(env)) == 2


@needs_pg
def test_queue_twice_plus_sweep_is_one_event_also_when_stuck(env):
    from datetime import datetime, timezone
    from apps.api.services import agent_notify
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner)
    one = env.asset(req, "Hook 1", versions=3, by=agent.who)
    stats, status = {str(one.id): clear(one.versions[2], 1)}, {req.review_share_token: {"status": "held", "openMustFixes": 1}}
    with patch("apps.api.services.review_bridge.asset_stats", return_value=stats), \
         patch("apps.api.services.review_bridge.request_status", return_value=status):
        for _ in range(2):
            assert env.client.get("/agent/queue", headers=agent.headers).status_code == 200
        with env.Session() as db:
            assert agent_notify.sweep(db, datetime.now(timezone.utc)) == 0
    [row] = logs(env)
    assert row.payload["agent_stuck"] is True
