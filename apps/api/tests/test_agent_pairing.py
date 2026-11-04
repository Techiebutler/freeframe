"""P1: owner pairing codes, POST /agents/pair, Bearer ara_ auth."""
import re
from datetime import datetime, timedelta, timezone

from .agent_pg import env, needs_pg  # noqa: F401

pytestmark = needs_pg


def _code(e, project=None, headers=None):
    r = e.client.post(f"/projects/{(project or e.project_a).id}/agent-pairing-codes", headers=headers or e.headers(e.owner))
    assert r.status_code == 201, r.text
    return r.json()["code"]


def _pair(e, code, name="Cutter", program="codex"):
    return e.client.post("/agents/pair", json={"code": code, "agent_name": name, "program": program})


def test_owner_creates_code_in_contract_format(env):
    r = env.client.post(f"/projects/{env.project_a.id}/agent-pairing-codes", headers=env.headers(env.owner))
    assert r.status_code == 201
    assert re.fullmatch(r"[A-Z2-9]{8}", r.json()["code"])
    assert datetime.fromisoformat(r.json()["expires_at"]) > datetime.now(timezone.utc) + timedelta(minutes=14)


def test_only_the_owner_creates_codes(env):
    stranger = env.user("Stranger")
    assert env.client.post(f"/projects/{env.project_a.id}/agent-pairing-codes", headers=env.headers(stranger)).status_code == 403


def test_pairing_creates_an_agent_editor_and_a_working_key(env):
    r = _pair(env, _code(env))
    assert r.status_code == 200, r.text
    body = r.json()
    assert re.fullmatch(r"ara_[A-Za-z0-9_-]{40}", body["agent_key"])
    assert body["project_id"] == str(env.project_a.id) and body["project_name"] == "Brand A"
    from apps.api.models.project import ProjectMember, ProjectRole
    from apps.api.models.user import User
    with env.Session() as db:
        u = db.get(User, body["user_id"])
        assert (u.kind, u.is_staff, u.name) == ("agent", False, "Cutter (codex)")
        assert re.fullmatch(r"agent\+[0-9a-f-]{36}@agents\.autoreview\.local", u.email)
        m = db.query(ProjectMember).filter_by(user_id=u.id, project_id=env.project_a.id).one()
        assert m.role == ProjectRole.editor
    me = env.client.get("/agent/me", headers={"Authorization": f"Bearer {body['agent_key']}"})
    assert me.status_code == 200
    assert me.json() == {"user_id": body["user_id"], "name": "Cutter (codex)", "program": "codex",
                         "project_id": str(env.project_a.id), "project_name": "Brand A", "brand_slug": None}


def test_key_is_stored_only_as_sha256(env):
    import hashlib
    from apps.api.models.agent import AgentKey
    key = _pair(env, _code(env)).json()["agent_key"]
    with env.Session() as db:
        assert db.query(AgentKey).one().key_hash == hashlib.sha256(key.encode()).hexdigest()


def test_repairing_same_name_and_program_rotates_the_key_of_the_same_user(env):
    a = _pair(env, _code(env)).json()
    b = _pair(env, _code(env)).json()
    assert a["user_id"] == b["user_id"] and a["agent_key"] != b["agent_key"]
    assert env.client.get("/agent/me", headers={"Authorization": f"Bearer {a['agent_key']}"}).status_code == 401
    assert env.client.get("/agent/me", headers={"Authorization": f"Bearer {b['agent_key']}"}).status_code == 200
    other = _pair(env, _code(env), program="hermes").json()
    assert other["user_id"] != a["user_id"]


def test_code_is_single_use_and_expires_and_unknown(env):
    code = _code(env)
    assert _pair(env, code).status_code == 200
    r = _pair(env, code)
    assert (r.status_code, r.json()["detail"]) == (410, "code_used")
    from apps.api.models.agent import AgentPairingCode
    stale = _code(env)
    with env.Session() as db:
        for c in db.query(AgentPairingCode).filter(AgentPairingCode.used_at.is_(None)).all():
            c.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.commit()
    r = _pair(env, stale)
    assert (r.status_code, r.json()["detail"]) == (410, "code_expired")
    r = _pair(env, "ZZZZZZZZ")
    assert (r.status_code, r.json()["detail"]) == (404, "code_unknown")


def test_unknown_program_is_422(env):
    assert _pair(env, _code(env), program="skynet").status_code == 422


def test_bad_or_missing_key_is_401(env):
    assert env.client.get("/agent/me").status_code == 401
    r = env.client.get("/agent/me", headers={"Authorization": "Bearer ara_" + "x" * 40})
    assert (r.status_code, r.json()["detail"]) == (401, "invalid_agent_key")
    r = env.client.get("/agent/me", headers={"Authorization": "Bearer not-an-agent-key"})
    assert (r.status_code, r.json()["detail"]) == (401, "invalid_agent_key")


def test_owner_lists_and_revokes_agents(env):
    paired = _pair(env, _code(env)).json()
    key = {"Authorization": f"Bearer {paired['agent_key']}"}
    assert env.client.get("/agent/me", headers=key).status_code == 200
    rows = env.client.get(f"/projects/{env.project_a.id}/agents", headers=env.headers(env.owner)).json()
    assert len(rows) == 1 and rows[0]["name"] == "Cutter (codex)" and rows[0]["program"] == "codex"
    assert rows[0]["agent_name"] == "Cutter" and rows[0]["revoked"] is False and rows[0]["last_used_at"]
    assert env.client.delete(f"/projects/{env.project_a.id}/agents/{paired['user_id']}", headers=env.headers(env.owner)).status_code == 204
    r = env.client.get("/agent/me", headers=key)
    assert (r.status_code, r.json()["detail"]) == (403, "revoked_agent_key")
    assert env.client.get(f"/projects/{env.project_a.id}/agents", headers=env.headers(env.owner)).json()[0]["revoked"] is True
    # pairing again brings the same agent back with a fresh key
    again = _pair(env, _code(env)).json()
    assert again["user_id"] == paired["user_id"]
    assert env.client.get("/agent/me", headers={"Authorization": f"Bearer {again['agent_key']}"}).status_code == 200


def test_other_projects_agents_are_not_listed_or_revocable(env):
    paired = _pair(env, _code(env)).json()
    assert env.client.get(f"/projects/{env.project_b.id}/agents", headers=env.headers(env.owner)).json() == []
    assert env.client.delete(f"/projects/{env.project_b.id}/agents/{paired['user_id']}", headers=env.headers(env.owner)).status_code == 404


def test_owner_toggles_agents_may_approve(env):
    r = env.client.patch(f"/projects/{env.project_a.id}", json={"agents_may_approve": True}, headers=env.headers(env.owner))
    assert r.status_code == 200 and r.json()["agents_may_approve"] is True


def test_me_returns_the_workspace_brand_slug(env):
    from apps.api.models.project import Project
    with env.Session() as db:
        db.get(Project, env.project_a.id).autoreview_brand_slug = "mynd-organics"
        db.commit()
    key = _pair(env, _code(env)).json()["agent_key"]
    assert env.client.get("/agent/me", headers={"Authorization": f"Bearer {key}"}).json()["brand_slug"] == "mynd-organics"


def test_blank_agent_name_is_422(env):
    assert _pair(env, _code(env), name="   ").status_code == 422


def test_last_used_at_is_written_at_most_once_a_minute(env):
    from apps.api.models.agent import AgentKey
    key = _pair(env, _code(env)).json()["agent_key"]
    headers = {"Authorization": f"Bearer {key}"}
    env.client.get("/agent/me", headers=headers)
    with env.Session() as db:
        first = db.query(AgentKey).one().last_used_at
    env.client.get("/agent/me", headers=headers)
    with env.Session() as db:
        assert db.query(AgentKey).one().last_used_at == first
        db.query(AgentKey).one().last_used_at = first - timedelta(minutes=2)
        db.commit()
    env.client.get("/agent/me", headers=headers)
    with env.Session() as db:
        assert db.query(AgentKey).one().last_used_at > first


def test_a_pairing_race_retries_once_instead_of_500(env):
    from sqlalchemy.exc import IntegrityError
    from apps.api.services import agents
    code = _code(env)
    with env.Session() as db:
        real, calls = db.commit, []
        def flaky():
            calls.append(1)
            if len(calls) == 1:
                raise IntegrityError("insert", {}, Exception("uq_agent_keys_project_program_name"))
            return real()
        db.commit = flaky
        plain, key, _ = agents.pair(db, code, "Cutter", "codex")
    assert plain.startswith("ara_") and len(calls) == 2


def test_revoking_removes_the_agent_from_the_project_and_pairing_restores_it(env):
    from apps.api.models.project import ProjectMember
    paired = _pair(env, _code(env)).json()
    env.client.delete(f"/projects/{env.project_a.id}/agents/{paired['user_id']}", headers=env.headers(env.owner))
    with env.Session() as db:
        assert db.query(ProjectMember).filter_by(user_id=paired["user_id"]).one().deleted_at is not None
    _pair(env, _code(env))
    with env.Session() as db:
        assert db.query(ProjectMember).filter_by(user_id=paired["user_id"]).one().deleted_at is None


def test_a_project_editor_manages_agents_but_an_agent_cannot(env):
    from apps.api.models.project import ProjectMember, ProjectRole
    editor = env.user("Editor")
    with env.Session() as db:
        db.add(ProjectMember(project_id=env.project_a.id, user_id=editor.id, role=ProjectRole.editor))
        db.commit()
    code = _code(env, headers=env.headers(editor))
    paired = _pair(env, code).json()
    assert env.client.get(f"/projects/{env.project_a.id}/agents", headers=env.headers(editor)).status_code == 200
    agent = {"Authorization": f"Bearer {paired['agent_key']}"}
    assert env.client.post(f"/projects/{env.project_a.id}/agent-pairing-codes", headers=agent).status_code in (401, 403)
    assert env.client.delete(f"/projects/{env.project_a.id}/agents/{paired['user_id']}", headers=env.headers(editor)).status_code == 204
