"""Agent Mode M3: keys straight from the UI, read/deliver scopes, the per-key rate limit."""
import hashlib
import re
from unittest.mock import patch

from .agent_pg import env, needs_pg  # noqa: F401

pytestmark = needs_pg


def _key(e, scope=None, name="GPT", program="chatgpt", headers=None, project=None):
    body = {"agent_name": name, "program": program, **({"scope": scope} if scope else {})}
    return e.client.post(f"/projects/{(project or e.project_a).id}/agent-keys", json=body, headers=headers or e.headers(e.owner))


def _bearer(key):
    return {"Authorization": f"Bearer {key}"}


def test_key_is_shown_once_and_stored_only_as_sha256(env):
    r = _key(env)
    assert r.status_code == 201, r.text
    body = r.json()
    assert re.fullmatch(r"ara_[A-Za-z0-9_-]{40}", body["agent_key"]) and body["scope"] == "deliver"
    from apps.api.models.agent import AgentKey
    with env.Session() as db:
        assert db.query(AgentKey).one().key_hash == hashlib.sha256(body["agent_key"].encode()).hexdigest()
    listed = env.client.get(f"/projects/{env.project_a.id}/agents", headers=env.headers(env.owner)).json()
    assert body["agent_key"] not in str(listed) and listed[0]["scope"] == "deliver" and listed[0]["program"] == "chatgpt"
    assert env.client.get("/agent/me", headers=_bearer(body["agent_key"])).status_code == 200


def test_same_program_and_name_rotates_the_key(env):
    a, b = _key(env).json(), _key(env, scope="read").json()
    assert a["user_id"] == b["user_id"] and b["scope"] == "read"
    assert env.client.get("/agent/me", headers=_bearer(a["agent_key"])).status_code == 401


def test_strangers_and_agents_cannot_create_keys(env):
    assert _key(env, headers=env.headers(env.user("Stranger"))).status_code == 403
    agent = env.pair_agent(env.project_a)
    assert _key(env, headers=agent.headers).status_code in (401, 403)


def test_read_key_reads_but_may_not_deliver(env):
    key = _key(env, scope="read").json()["agent_key"]
    req = env.request(env.project_a, env.owner)
    queue = env.client.get("/agent/queue", headers=_bearer(key))
    assert queue.status_code == 200 and queue.json() and "upload_token" not in queue.json()[0]
    r = env.client.post("/agent/requests", json={"title": "Hook 2", "external_ref": "card-2"}, headers=_bearer(key))
    assert (r.status_code, r.json()["detail"]) == (403, "scope_read_only")
    body = {"original_filename": "Hook 1.mp4", "mime_type": "video/mp4", "file_size_bytes": 1000}
    with patch("apps.api.routers.requests.create_multipart_upload", return_value="uid"):
        up = env.client.post(f"/r/{req.token}/upload/initiate", json=body, headers=_bearer(key))
    assert (up.status_code, up.json()["detail"]) == (403, "scope_read_only")


def test_paired_keys_stay_deliver(env):
    agent = env.pair_agent(env.project_a)
    from apps.api.models.agent import AgentKey
    with env.Session() as db:
        assert db.query(AgentKey).one().scope == "deliver"
    env.request(env.project_a, env.owner)
    assert "upload_token" in env.client.get("/agent/queue", headers=agent.headers).json()[0]


def test_rate_limit_is_per_key_with_retry_after(env):
    key = _key(env).json()["agent_key"]
    seen = []

    def limiter(who, action, max_requests, window):
        seen.append((who, action, max_requests, window))
        return False, 42

    with patch("apps.api.services.redis_service.check_rate_limit", side_effect=limiter):
        r = env.client.get("/agent/me", headers=_bearer(key))
        w = env.client.post("/agent/requests", json={"title": "x", "external_ref": "y"}, headers=_bearer(key))
    assert (r.status_code, r.headers["retry-after"]) == (429, "42") and w.status_code == 429
    from apps.api.models.agent import AgentKey
    with env.Session() as db:
        key_id = str(db.query(AgentKey).one().id)
    assert seen == [(key_id, "agent_read", 120, 600), (key_id, "agent_write", 30, 600)]
