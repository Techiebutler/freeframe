"""A superadmin managing someone else's project.

The membership endpoints and the rename are owner tier, which an administrator
reaches past their own membership. Real Postgres over HTTP, for the reason the
storage half of these tests gives. Harness shared, in conftest.
"""
import pytest

from apps.api.models.project import ProjectMember, ProjectRole

# ── a superadmin managing someone else's project ──────────────────────────────

@pytest.mark.parametrize(
    "who", ["admin", "outsider"], ids=["a superadmin may", "an outsider may not"],
)
def test_who_adds_changes_removes_a_member_and_renames_a_project(
    seed, as_user, admin, monkeypatch, who,
):
    """Every membership endpoint and the rename are owner tier, which a superadmin reaches
    past their own membership and an outsider never does."""
    is_admin = who == "admin"
    sent = []
    monkeypatch.setattr(
        "apps.api.routers.projects.send_task_safe",
        lambda task, **kw: sent.append(kw) if is_admin else pytest.fail(
            "an outsider must not send mail",
        ),
    )
    owner = seed.user()
    project = seed.project(owner, name="old name")
    member = seed.user()
    seed.member(project, member, ProjectRole.viewer)
    newcomer = seed.user(name="New Person")
    client = as_user(admin if is_admin else seed.user())
    ok = 200 if is_admin else 403
    added = client.post(f"/projects/{project.id}/members", json={
        "user_id": str(newcomer.id), "role": "editor",
    })
    assert added.status_code == (201 if is_admin else 403)
    if is_admin:
        assert added.json()["role"] == "editor"
        # Behaviour left exactly as for an owner: adding a member emails them.
        assert [m["to_email"] for m in sent] == [newcomer.email]
    changed = client.patch(
        f"/projects/{project.id}/members/{member.id}", json={"role": "editor"},
    )
    assert changed.status_code == ok
    if is_admin:
        assert changed.json()["role"] == "editor"
    removed = client.delete(f"/projects/{project.id}/members/{member.id}")
    assert removed.status_code == (204 if is_admin else 403)
    row = seed.db.query(ProjectMember).filter(
        ProjectMember.project_id == project.id, ProjectMember.user_id == member.id,
    ).one()
    assert (row.deleted_at is not None) is is_admin
    renamed = client.patch(f"/projects/{project.id}", json={"name": "new name"})
    assert renamed.status_code == ok
    if is_admin:
        assert renamed.json()["name"] == "new name"


@pytest.mark.parametrize("how", ["remove", "demote"])
def test_the_last_owner_is_protected(seed, as_user, admin, how):
    """Every membership endpoint is owner tier, so an ownerless project locks its own
    people out of their settings. Demoting the last owner leaves the same ownerless project
    behind as removing them; with a second owner in place, either is allowed."""
    owner = seed.user()
    project = seed.project(owner)
    client = as_user(admin)

    def _try():
        if how == "remove":
            return client.delete(f"/projects/{project.id}/members/{owner.id}")
        return client.patch(
            f"/projects/{project.id}/members/{owner.id}", json={"role": "editor"},
        )
    refused = _try()
    assert refused.status_code == 400
    assert "only owner" in refused.json()["detail"]
    seed.member(project, seed.user(), ProjectRole.owner)
    assert _try().status_code in (200, 204)
