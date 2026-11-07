"""handin.v1 brands: an agent key lists/creates the owner's brands and files requests into a chosen one."""
import uuid

from .agent_pg import env, needs_pg  # noqa: F401

pytestmark = needs_pg


def members(env, project_id):
    from apps.api.models.project import ProjectMember
    with env.Session() as db:
        return {(str(m.user_id), m.role.value) for m in db.query(ProjectMember).filter(ProjectMember.project_id == project_id, ProjectMember.deleted_at.is_(None))}


def test_list_shows_only_the_owners_brands(env):
    other = env.user("Other")
    env.project(other, "Foreign Brand")
    with env.Session() as db:
        from apps.api.models.project import Project
        db.get(Project, env.project_b.id).autoreview_brand_slug = "brand-b"
        db.commit()
    agent = env.pair_agent(env.project_a)
    out = env.client.get("/agent/brands", headers=agent.headers)
    assert out.status_code == 200
    assert out.json() == {"brands": [
        {"brand_id": str(env.project_a.id), "name": "Brand A", "aliases": [], "home": True},
        {"brand_id": str(env.project_b.id), "name": "Brand B", "aliases": ["brand-b"], "home": False}]}


def test_create_brand_is_idempotent_by_normalized_name(env):
    agent = env.pair_agent(env.project_a)
    first = env.client.post("/agent/brands", json={"name": "Glow Wand", "website": "https://glow.test"}, headers=agent.headers)
    assert first.status_code == 201
    body = first.json()
    assert body["created"] is True and body["name"] == "Glow Wand"
    for variant in ("glow-wand", " glow_wand ", "GLOW   WAND"):
        again = env.client.post("/agent/brands", json={"name": variant}, headers=agent.headers)
        assert (again.status_code, again.json()) == (200, {"brand_id": body["brand_id"], "name": "Glow Wand", "created": False})
    from apps.api.models.project import Project
    with env.Session() as db:
        p = db.get(Project, uuid.UUID(body["brand_id"]))
        assert p.created_by == env.owner.id and p.description == "https://glow.test"
    assert members(env, uuid.UUID(body["brand_id"])) == {(agent.user_id, "editor")}
    assert [b["name"] for b in env.client.get("/agent/brands", headers=agent.headers).json()["brands"]] == ["Brand A", "Brand B", "Glow Wand"]


def test_create_brand_does_not_match_another_owners_name(env):
    other = env.user("Other")
    env.project(other, "Glow Wand")
    agent = env.pair_agent(env.project_a)
    assert env.client.post("/agent/brands", json={"name": "glow wand"}, headers=agent.headers).status_code == 201


def test_request_for_chosen_brand_adds_membership(env):
    agent = env.pair_agent(env.project_a)
    assert (agent.user_id, "editor") not in members(env, env.project_b.id)
    r = env.client.post("/agent/requests", json={"title": "Hook 1", "external_ref": "card-1", "brand_id": str(env.project_b.id)}, headers=agent.headers)
    assert r.status_code == 200 and r.json()["created"] is True
    assert (agent.user_id, "editor") in members(env, env.project_b.id)
    from apps.api.models.upload_request import UploadRequest
    with env.Session() as db:
        assert db.get(UploadRequest, uuid.UUID(r.json()["request_id"])).project_id == env.project_b.id
    again = env.client.post("/agent/requests", json={"title": "Hook 1", "external_ref": "card-1", "brand_id": str(env.project_b.id)}, headers=agent.headers)
    assert again.json()["request_id"] == r.json()["request_id"] and again.json()["created"] is False


def test_request_for_foreign_brand_is_404_with_next(env):
    other = env.user("Other")
    foreign = env.project(other, "Foreign")
    agent = env.pair_agent(env.project_a)
    for brand_id in (str(foreign.id), str(uuid.uuid4())):
        r = env.client.post("/agent/requests", json={"title": "x", "external_ref": "c", "brand_id": brand_id}, headers=agent.headers)
        assert (r.status_code, r.json()) == (404, {"error": "not_found", "next": "Brand is not in your workspace. Call list_brands."})


def test_request_without_brand_uses_home_project(env):
    agent = env.pair_agent(env.project_a)
    r = env.client.post("/agent/requests", json={"title": "Hook 1", "external_ref": "card-1"}, headers=agent.headers)
    from apps.api.models.upload_request import UploadRequest
    with env.Session() as db:
        assert db.get(UploadRequest, uuid.UUID(r.json()["request_id"])).project_id == env.project_a.id
