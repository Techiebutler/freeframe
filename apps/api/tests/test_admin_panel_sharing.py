"""The three reading tabs, and a superadmin managing someone else's project.

What projects exist, who inside the instance can reach which project, what is
reachable from outside, and the membership endpoints an administrator reaches
past their own membership. Real Postgres over HTTP, for the reason the storage
half of these tests gives. Harness shared, in conftest.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from apps.api.models.project import ProjectMember, ProjectRole
from apps.api.models.share import ShareLink, SharePermission
from apps.api.services import admin_panel

# ── every endpoint is superadmin only ─────────────────────────────────────────

@pytest.mark.parametrize(
    "path", ["/admin/projects", "/admin/shares/internal", "/admin/shares/external"],
)
def test_only_a_superadmin_reads_a_sharing_tab(seed, as_user, admin, path):
    assert as_user(seed.user()).get(path).status_code == 403
    assert as_user(admin).get(path).status_code == 200

# ── tab: projects ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("poster", [True, False], ids=["with a poster", "without one"])
def test_the_projects_tab_carries_what_a_card_draws(seed, as_user, admin, monkeypatch, poster):
    """The five facts the card and the row both show, so switching between them needs no
    second request. Without a poster the card falls back to the gradient `ProjectPoster`
    picks, and no signature is paid for. The size is the storage tab's figure: two tabs,
    one figure, and they used to read from different queries."""
    monkeypatch.setattr(
        admin_panel, "generate_presigned_get_url", lambda key: f"https://signed/{key}",
    )
    owner = seed.user()
    project = seed.project(owner, name="a project")
    if poster:
        project.poster_s3_key = "posters/p.jpg"
    seed.member(project, seed.user(), ProjectRole.editor)
    seed.media(project, owner, original=2_000, derived=1_000)
    seed.trash(seed.media(project, owner, name="binned", original=9_000, derived=0))
    seed.db.flush()
    binned = seed.project(owner, name="binned project", deleted=True)
    client = as_user(admin)
    rows = client.get("/admin/projects").json()
    row = next(r for r in rows if r["project_id"] == str(project.id))
    assert row["name"] == "a project"
    assert row["member_count"] == 2
    assert row["last_activity_at"] is not None
    assert row["poster_url"] == ("https://signed/posters/p.jpg" if poster else None)
    assert str(binned.id) not in {r["project_id"] for r in rows}, "the trash is not a tab"
    assert row["total_bytes"] == next(
        r for r in client.get("/admin/storage").json()["projects"]
        if r["project_id"] == str(project.id)
    )["total_bytes"] == 3_000

# ── tab: internal sharing ─────────────────────────────────────────────────────

def test_internal_sharing_groups_people_under_their_project_owners_first(seed, as_user, admin):
    """A membership that was removed is not a person who can reach it, and a trashed
    project is not a project this tab answers for."""
    owner = seed.user(name="Olive Owner")
    project = seed.project(owner, name="shared project")
    viewer = seed.user(name="Vera Viewer")
    viewer.avatar_color = "#abc"
    seed.member(project, viewer, ProjectRole.viewer)
    gone = seed.user(name="Gone Person")
    seed.trash(seed.member(project, gone, ProjectRole.editor))
    binned = seed.project(seed.user(), name="binned", deleted=True)
    rows = as_user(admin).get("/admin/shares/internal").json()
    row = next(r for r in rows if r["project_id"] == str(project.id))
    assert row["project_name"] == "shared project"
    assert [p["name"] for p in row["people"]] == ["Olive Owner", "Vera Viewer"]
    assert [p["role"] for p in row["people"]] == ["owner", "viewer"]
    assert row["has_live_people"] is True
    # The avatar fields the grouped card draws, so no second request per person.
    assert {"avatar_url", "avatar_color"} <= set(row["people"][1])
    assert row["people"][1]["avatar_color"] == "#abc"
    assert str(binned.id) not in {r["project_id"] for r in rows}


@pytest.mark.parametrize("survivor", [False, True], ids=["nobody left", "one person left"])
def test_a_project_whose_owner_was_deleted_stays_in_internal_sharing(
    seed, as_user, admin, survivor,
):
    """It used to drop out silently, leaving a project that Projects and Storage both
    showed with no way to repair who could reach it."""
    owner = seed.user(name="Gone Owner")
    project = seed.project(owner, name="orphaned")
    if survivor:
        seed.member(project, seed.user(name="Still Here"), ProjectRole.editor)
    seed.trash(owner)
    rows = as_user(admin).get("/admin/shares/internal").json()
    row = next(r for r in rows if r["project_id"] == str(project.id))
    assert [p["name"] for p in row["people"]] == (["Still Here"] if survivor else [])
    assert row["has_live_people"] is survivor
    if not survivor:
        assert rows[0]["project_id"] == str(project.id), "what needs a decision comes first"

# ── tab: external sharing ─────────────────────────────────────────────────────

def _share(db, project, creator, **kwargs):
    link = ShareLink(
        project_id=project.id, token=f"tok-{uuid.uuid4().hex}", created_by=creator.id,
        title=kwargs.pop("title", "a link"),
        permission=kwargs.pop("permission", SharePermission.view),
        **kwargs,
    )
    db.add(link)
    db.flush()
    return link


def test_external_sharing_lists_only_working_links_with_their_rights(seed, as_user, admin):
    """What is shared, what it allows, when it stops and who made it. A link that is
    switched off, deleted or expired leads nowhere, so it is not on a list of what is
    reachable from outside."""
    owner = seed.user(name="Olive Owner")
    project = seed.project(owner, name="client project")
    working = _share(seed.db, project, owner, allow_download=True, password_hash="x")
    _share(seed.db, project, owner, is_enabled=False)
    _share(seed.db, project, owner, deleted_at=datetime.now(timezone.utc))
    _share(seed.db, project, owner, expires_at=datetime.now(timezone.utc) - timedelta(days=1))
    rows = as_user(admin).get("/admin/shares/external").json()
    assert [r["token"] for r in rows] == [working.token]
    [row] = rows
    assert (row["what"], row["kind"], row["permission"]) == ("client project", "project", "view")
    assert row["allow_download"] is True
    assert row["has_password"] is True
    assert row["expires_at"] is None
    assert row["created_by_name"] == "Olive Owner"

    # Switched off through the app's own revoke, which notifies nobody: there is
    # no admin-only revoke path that could drift from it, and nobody below an
    # admin may use it on a project they are not in.
    assert as_user(seed.user()).delete(f"/share/{working.token}").status_code == 403
    seed.db.refresh(working)
    assert working.deleted_at is None
    assert as_user(admin).delete(f"/share/{working.token}").status_code == 204
    seed.db.refresh(working)
    assert working.deleted_at is not None
    assert as_user(admin).get("/admin/shares/external").json() == []

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
