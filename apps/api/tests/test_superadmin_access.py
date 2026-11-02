"""A superadmin reaches every project; nobody else gains anything.

Against real Postgres: what is tested is which rows the permission queries match
and which status comes back, and the mock session answers every query truthily.
Pinned here: every tier passes for an admin with no membership and the stand-in
membership is never persisted; the ordinary 403s are untouched; every tier taken
past one's own membership lands in the activity log, read tiers and the asset
path included, one row per request and project; `can_access_asset`, the event
stream and share links agree with the role gate; and over HTTP reading, listing
with `scope=all`, deleting, uploading and moderating someone else's comment all
reach a project the admin is not in.
"""
import uuid

from fastapi import HTTPException
import pytest

from apps.api.models.activity import ActivityLog
from apps.api.models.asset import Asset, AssetType, AssetVersion
from apps.api.models.comment import Comment, CommentAttachment
from apps.api.models.project import ProjectMember, ProjectRole
from apps.api.models.share import ShareLink, SharePermission
from apps.api.services import permissions

ALL_TIERS = [ProjectRole.viewer, ProjectRole.reviewer, ProjectRole.editor, ProjectRole.owner]
BELOW_ADMIN = [None, ProjectRole.viewer, ProjectRole.reviewer, ProjectRole.editor]


def admin_log(db, project_id):
    """The `admin_access` rows recorded for one project."""
    return (
        db.query(ActivityLog)
        .filter(
            ActivityLog.project_id == project_id,
            ActivityLog.action == permissions.ADMIN_ACCESS_ACTION,
        )
        .all()
    )

# ── the flag, and the role gate ───────────────────────────────────────────────

@pytest.mark.parametrize("tier", ALL_TIERS)
def test_superadmin_passes_every_tier_without_membership_and_is_logged(seed, tier):
    """Read tiers included. A review tool's reason for wanting this log is the line that
    says an outsider was in there, and "they only looked" is exactly what a project owner
    asks about afterwards. The stand-in membership is never written to the table."""
    owner = seed.user()
    project = seed.project(owner)
    admin = seed.user(superadmin=True)
    assert permissions.is_instance_admin(admin) is True
    assert permissions.is_instance_admin(owner) is False
    # A share-link caller has no user at all; it must answer, not raise.
    assert permissions.is_instance_admin(None) is False
    member = permissions.require_project_role(seed.db, project.id, admin, tier)
    seed.db.flush()
    assert member.role == ProjectRole.owner
    [logged] = admin_log(seed.db, project.id)
    assert logged.user_id == admin.id
    assert logged.payload == {
        "via": "superadmin", "membership": "none", "required_role": tier.value,
        "scope": tier.value,
    }
    rows = seed.db.query(ProjectMember).filter(
        ProjectMember.project_id == project.id, ProjectMember.deleted_at.is_(None),
    ).all()
    assert [r.user_id for r in rows] == [owner.id]


@pytest.mark.parametrize(
    ("case", "status", "detail"),
    [
        ("an outsider", 403, "Not a project member"),
        ("a member below the tier", 403, "Requires editor role or higher"),
        ("a deleted project, even for an admin", 404, "Project not found"),
    ],
)
def test_the_ordinary_refusals_are_untouched(seed, case, status, detail):
    """An owner of their *own* project elsewhere is still an outsider here: a high project
    role is no instance-wide access, and the flag does not reach into the trash."""
    deleted = case.startswith("a deleted")
    owner = seed.user()
    project = seed.project(owner, deleted=deleted)
    tier = ProjectRole.viewer
    if deleted:
        caller = seed.user(superadmin=True)
    elif case == "an outsider":
        caller = seed.user()
        seed.project(caller)
    else:
        caller = seed.user()
        seed.member(project, caller, ProjectRole.viewer)
        tier = ProjectRole.editor
    with pytest.raises(HTTPException) as refused:
        permissions.require_project_role(seed.db, project.id, caller, tier)
    assert refused.value.status_code == status
    assert refused.value.detail == detail


@pytest.mark.parametrize(
    ("own", "required", "logged"),
    [
        (ProjectRole.editor, ProjectRole.editor, False),
        (ProjectRole.viewer, ProjectRole.owner, True),
    ],
    ids=["their own role covers it", "past their own role"],
)
def test_a_superadmin_who_is_a_member_uses_their_own_row_until_it_runs_out(
    seed, own, required, logged,
):
    project = seed.project(seed.user())
    admin = seed.user(superadmin=True)
    seed.member(project, admin, own)
    member = permissions.require_project_role(seed.db, project.id, admin, required)
    seed.db.flush()
    rows = admin_log(seed.db, project.id)
    if not logged:
        assert member.id is not None, "the real row, not the stand-in"
        assert member.role == own
        assert rows == [], "their own role covered it, nothing administrative happened"
    else:
        assert member.role == ProjectRole.owner
        [row] = rows
        assert row.payload == {
            "via": "superadmin", "membership": own.value,
            "required_role": required.value, "scope": required.value,
        }

# ── the audit trail: one row per request and project, heaviest access wins ────

@pytest.mark.parametrize(
    "order",
    [("visible", "owner"), ("owner", "visible"), ("owner", "owner", "owner")],
    ids=["read then write", "write then read", "the same gate three times"],
)
def test_one_row_per_request_and_project_reporting_the_heaviest_access(seed, order):
    """A listing runs the gate per item, so an endpoint returning two hundred assets must
    not write two hundred rows. Read then delete reports the delete, a later read never
    downgrades it, and two projects in one request are two rows."""
    owner = seed.user()
    project, second = seed.project(owner), seed.project(owner)
    admin = seed.user(superadmin=True)
    for step in order:
        if step == "visible":
            permissions.require_project_visible(seed.db, project.id, admin)
        else:
            permissions.require_project_role(seed.db, project.id, admin, ProjectRole.owner)
    permissions.require_project_role(seed.db, second.id, admin, ProjectRole.editor)
    seed.db.flush()
    [logged] = admin_log(seed.db, project.id)
    assert logged.payload["required_role"] == "owner"
    assert len(admin_log(seed.db, second.id)) == 1


@pytest.mark.parametrize("scope", ["asset", "events"])
def test_the_asset_and_event_paths_are_logged_once_each(seed, scope):
    """`can_access_asset` has no audit hook on purpose, `require_asset_access` does: the
    comment, attachment and version routes all go through it. The stream re-checks for as
    long as it stays open, so only the connect check carries `audit`."""
    owner = seed.user()
    project = seed.project(owner)
    admin = seed.user(superadmin=True)
    if scope == "asset":
        asset = seed.asset(project, owner)
        permissions.require_asset_access(seed.db, asset, admin)
    else:
        assert permissions.project_events_denial(seed.db, project.id, admin.id, 1, True) is None
        assert permissions.project_events_denial(seed.db, project.id, admin.id, 1) is None
    seed.db.flush()
    [logged] = admin_log(seed.db, project.id)
    assert logged.payload["scope"] == scope
    if scope == "asset":
        assert logged.asset_id == asset.id
        assert logged.payload["required_role"] is None


@pytest.mark.parametrize(
    "case",
    ["a member's own write", "filtering a list per item", "a member subscribing",
     "a read-only request", "a read-only request on a dirty session"],
)
def test_which_requests_write_an_admin_access_row_and_which_never_do(seed, case):
    """`can_access_asset` is read per item to decide who a mention resolves to and who sees
    a comment; a row per item is the flood the audit has to avoid, and a member exercising
    their own right is no administrative reach even if they are a superadmin. A GET never
    commits, so its row would be dropped at session close: the helper `get_db` calls on its
    way out writes it, and only it, because half of somebody else's transaction is the
    worse bug by far."""
    owner = seed.user(superadmin=True)
    project = seed.project(owner)
    if case == "a member's own write":
        permissions.require_project_role(seed.db, project.id, owner, ProjectRole.owner)
    elif case == "filtering a list per item":
        admin = seed.user(superadmin=True)
        assets = [seed.asset(project, owner) for _ in range(20)]
        assert all(permissions.can_access_asset(seed.db, a, admin) for a in assets)
    elif case == "a member subscribing":
        assert permissions.project_events_denial(seed.db, project.id, owner.id, 1, True) is None
    else:
        admin = seed.user(superadmin=True)
        permissions.require_project_visible(seed.db, project.id, admin)
        if case.endswith("dirty session"):
            seed.db.add(Asset(
                project_id=project.id, name="half written", asset_type=AssetType.video,
                created_by=admin.id,
            ))
            assert permissions.persist_admin_access_audit(seed.db) == 0
            return
        assert permissions.persist_admin_access_audit(seed.db) == 1
        assert len(admin_log(seed.db, project.id)) == 1
        return
    seed.db.flush()
    assert admin_log(seed.db, project.id) == [], "not an administrative reach"


def test_a_read_only_request_commits_the_admin_access_row_on_its_way_out(seed, monkeypatch):
    """`get_db` is where a GET's row is written, so the wiring needs its own case: the gate
    leaves the row pending, the request commits nothing of its own, and without the call in
    the dependency's `finally` the row would be dropped at session close and the audit would
    show writes only."""
    from apps.api import database
    monkeypatch.setattr(database, "SessionLocal", lambda: seed.db)
    monkeypatch.setattr(seed.db, "close", lambda: None)
    owner = seed.user()
    project = seed.project(owner)
    admin = seed.user(superadmin=True)
    gen = database.get_db()
    permissions.require_project_visible(next(gen), project.id, admin)
    assert seed.db.new, "the gate adds the row without committing it"
    gen.close()
    assert not seed.db.new, "the dependency wrote the row on its way out"
    [logged] = admin_log(seed.db, project.id)
    assert logged.user_id == admin.id


def test_restoring_someone_elses_project_runs_through_the_gate_and_is_logged(seed, as_user):
    """`POST /projects/{id}/restore` is the one project endpoint whose subject is a project
    the gate would answer 404 for, so it used to spell the superadmin check out by hand and
    wrote no row: an outsider could take a project back out of the trash and leave no trace
    of having been there, while the upgrade note promises that every reach past an admin's
    own membership is logged. It now goes through `require_project_role` with the trashed
    project in hand, so the owner tier, the refusals and the audit row are the same ones
    every other reach gets. An owner restoring their own project is not an administrative
    reach and is still not logged."""
    owner = seed.user()
    project = seed.project(owner, deleted=True)
    admin = seed.user(superadmin=True)
    assert as_user(admin).post(f"/projects/{project.id}/restore").status_code == 200
    seed.db.refresh(project)
    assert project.deleted_at is None
    [logged] = admin_log(seed.db, project.id)
    assert logged.user_id == admin.id
    assert logged.payload == {
        "via": "superadmin", "membership": "none",
        "scope": "owner", "required_role": "owner",
    }
    mine = seed.project(owner, deleted=True)
    assert as_user(owner).post(f"/projects/{mine.id}/restore").status_code == 200
    assert admin_log(seed.db, mine.id) == [], "an owner's own restore is no admin reach"

# ── visibility, assets, the event stream and share links ──────────────────────

def test_visibility_and_asset_access_follow_the_same_rule_as_the_role_gate(seed):
    """A public project stays readable by a non-member, answered with None rather than a
    membership; a private one is not readable at all; and no flag reaches an asset whose
    project is in the trash."""
    owner = seed.user()
    project = seed.project(owner)
    asset = seed.asset(project, owner)
    admin = seed.user(superadmin=True)
    assert permissions.require_project_visible(
        seed.db, project.id, admin,
    ).role == ProjectRole.owner
    with pytest.raises(HTTPException) as refused:
        permissions.require_project_visible(seed.db, project.id, seed.user())
    assert refused.value.status_code == 403
    public = seed.project(seed.user(), public=True)
    assert permissions.require_project_visible(seed.db, public.id, seed.user()) is None
    assert permissions.can_access_asset(seed.db, asset, admin) is True
    assert permissions.can_access_asset(seed.db, asset, seed.user()) is False
    seed.trash(project)
    assert permissions.can_access_asset(seed.db, asset, admin) is False


@pytest.mark.parametrize(
    ("who", "bump", "expected"),
    [
        ("admin", 0, None),
        ("outsider", 0, "EVENTS_ACCESS_REVOKED"),
        ("admin", 1, "EVENTS_TOKEN_REVOKED"),
    ],
    ids=["admin may subscribe", "non-member is revoked", "a stale token beats the flag"],
)
def test_the_event_stream_and_a_share_link_follow_the_same_rules(seed, who, bump, expected):
    """The customer-facing share path reads nothing off a user: the flag cannot change
    which links resolve, and a link into a trashed project stays unresolvable."""
    owner = seed.user()
    project = seed.project(owner)
    caller = seed.user(superadmin=(who == "admin"))
    link = ShareLink(
        token=f"tok-{uuid.uuid4().hex}", project_id=project.id,
        permission=SharePermission.view, created_by=owner.id, is_enabled=True,
    )
    seed.db.add(link)
    seed.db.flush()
    denial = permissions.project_events_denial(
        seed.db, project.id, caller.id, caller.token_version + bump,
    )
    assert denial == (getattr(permissions, expected) if expected else None)
    assert permissions.validate_share_link(seed.db, link.token).id == link.id
    seed.trash(project)
    with pytest.raises(HTTPException) as refused:
        permissions.validate_share_link(seed.db, link.token)
    assert refused.value.status_code == 404

# ── over HTTP: reading and listing someone else's project ─────────────────────

@pytest.mark.parametrize("caller", ["admin", "outsider", "outsider on a public project"])
def test_who_opens_a_project_and_its_member_list_uninvited(seed, as_user, caller):
    """Owner-equivalent for an admin, so the UI enables the actions the access actually
    allows; the member list only ever holds the real member. A public project is readable
    by anyone, but who can reach it never is."""
    owner = seed.user()
    public = caller.endswith("public project")
    project = seed.project(owner, name="theirs", public=public)
    is_admin = caller == "admin"
    client = as_user(seed.user(superadmin=is_admin, name="caller"))
    body = client.get(f"/projects/{project.id}")
    members = client.get(f"/projects/{project.id}/members")
    assert members.status_code == (200 if is_admin else 403)
    if is_admin:
        assert body.json()["name"] == "theirs"
        assert body.json()["role"] == "owner"
        assert [m["user_id"] for m in members.json()] == [str(owner.id)]
    elif not public:
        assert body.status_code == 403
        assert body.json()["detail"] == "Not a project member"


def test_scope_all_shows_every_project_to_a_superadmin_and_to_nobody_else(seed, as_user):
    """The default is untouched: without the switch an admin sees what they always saw, and
    an unknown scope is rejected rather than silently treated as the default."""
    theirs = seed.project(seed.user(), name="theirs")
    admin = seed.user(superadmin=True)
    mine = seed.project(admin, name="mine")
    trashed = seed.project(seed.user(), name="gone", deleted=True)
    client = as_user(admin)
    all_ids = {p["id"] for p in client.get("/projects?scope=all").json()}
    mine_ids = {p["id"] for p in client.get("/projects").json()}
    assert {str(theirs.id), str(mine.id)} <= all_ids
    assert str(trashed.id) not in all_ids, "the trash is not a project list"
    assert str(mine.id) in mine_ids
    assert str(theirs.id) not in mine_ids
    assert client.get("/projects?scope=everything").status_code == 422
    outsider = seed.user()
    seed.project(outsider)
    refused = as_user(outsider).get("/projects?scope=all")
    assert refused.status_code == 403
    assert refused.json()["detail"] == "Admin access required"


def test_the_overview_endpoints_keep_a_narrow_contract(seed, as_user):
    """Owner names, asset counts and the originals/derived split were dropped with the
    columns that showed them; left in the response they would be back in the table within
    a release. Largest first, instance-wide, and the detail endpoint nests the versions."""
    owner = seed.user()
    big = seed.project(owner, name="big project")
    small = seed.project(owner, name="small project")
    seed.media(big, owner, original=100_000, derived=400_000)
    seed.media(small, owner, original=1_000, derived=2_000)
    client = as_user(seed.user(superadmin=True))
    body = client.get("/admin/storage").json()
    totals = [r["total_bytes"] for r in body["projects"]]
    assert totals == sorted(totals, reverse=True)
    assert set(body["projects"][0]) == {"project_id", "name", "total_bytes"}
    for gone in ("counted_sources", "original_bytes", "derived_bytes", "file_count"):
        assert gone not in body
    seed.media(big, owner, name="multi", versions=3, original=10, derived=0)
    detail = client.get(f"/admin/storage/projects/{big.id}").json()
    multi = next(a for a in detail["assets"] if a["name"] == "multi")
    # Newest first, and only the newest carries the flag the delete gate reads.
    assert [v["version_number"] for v in multi["versions"]] == [3, 2, 1]
    assert [v["is_latest"] for v in multi["versions"]] == [True, False, False]

# ── deleting through the app's own trash ──────────────────────────────────────

def test_deleting_as_a_superadmin_puts_things_in_the_existing_trash(seed, as_user):
    """No new hard-delete path: the admin surface calls the same endpoint the asset menu
    calls, the row is soft-deleted, it shows up in the project's trash and it can be
    restored from there."""
    owner = seed.user()
    project = seed.project(owner)
    asset = seed.media(project, owner)
    admin = seed.user(superadmin=True)
    client = as_user(admin)
    assert client.delete(f"/assets/{asset.id}").status_code == 204
    seed.db.refresh(asset)
    assert asset.deleted_at is not None
    trash = client.get(f"/projects/{project.id}/trash").json()
    assert [a["id"] for a in trash["assets"]] == [str(asset.id)]
    assert client.post(f"/assets/{asset.id}/restore").status_code == 200
    seed.db.refresh(asset)
    assert asset.deleted_at is None

    # And the delete is in the activity log as an administrative reach.
    client.delete(f"/assets/{asset.id}")
    [logged] = admin_log(seed.db, project.id)
    assert logged.user_id == admin.id
    assert logged.payload["membership"] == "none"
    assert client.delete(f"/projects/{project.id}").status_code == 204
    seed.db.refresh(project)
    assert project.deleted_at is not None


@pytest.mark.parametrize(
    "role", [None, ProjectRole.viewer, ProjectRole.reviewer],
    ids=["outsider", "viewer", "reviewer"],
)
def test_nobody_below_editor_can_delete(seed, as_user, role):
    owner = seed.user()
    project = seed.project(owner)
    asset = seed.media(project, owner)
    other = seed.user()
    if role is not None:
        seed.member(project, other, role)
    client = as_user(other)
    assert client.delete(f"/assets/{asset.id}").status_code == 403
    assert client.delete(f"/projects/{project.id}").status_code == 403


@pytest.mark.parametrize("admin", [True, False], ids=["superadmin may", "outsider may not"])
def test_only_a_superadmin_uploads_into_a_project_they_are_not_in(
    seed, as_user, monkeypatch, admin,
):
    owner = seed.user()
    project = seed.project(owner)
    caller = seed.user(superadmin=admin)
    monkeypatch.setattr(
        "apps.api.routers.upload.create_multipart_upload",
        lambda key, content_type: "upload-1" if admin else pytest.fail(
            "an outsider must not reach S3",
        ),
    )
    resp = as_user(caller).post("/upload/initiate", json={
        "project_id": str(project.id),
        "asset_name": "admin upload",
        "original_filename": "admin.mp4",
        "mime_type": "video/mp4",
        "file_size_bytes": 1_000_000,
    })
    if not admin:
        assert resp.status_code == 403
        return
    assert resp.status_code == 200
    created = seed.db.query(Asset).filter(Asset.id == resp.json()["asset_id"]).one()
    assert created.project_id == project.id
    assert created.created_by == caller.id

# ── someone else's comment, and its attachment ────────────────────────────────

def _comment(db, asset, author, body="theirs"):
    version = db.query(AssetVersion).filter(AssetVersion.asset_id == asset.id).one()
    c = Comment(asset_id=asset.id, version_id=version.id, author_id=author.id, body=body)
    db.add(c)
    db.flush()
    return c


@pytest.mark.parametrize("role", ["superadmin", *BELOW_ADMIN])
def test_only_a_superadmin_moderates_a_comment_and_an_attachment_they_do_not_own(
    seed, as_user, monkeypatch, role,
):
    """The comment route used to query project_members itself, so an administrator could
    put the whole project in the trash but not fix one comment in it. Unchanged for anyone
    below superadmin, the message included; a project owner still moderates their own
    project, and that is not an admin reach."""
    is_admin = role == "superadmin"
    owner = seed.user()
    project = seed.project(owner)
    asset = seed.media(project, owner)
    comment = _comment(seed.db, asset, owner)
    attachment = CommentAttachment(
        comment_id=comment.id, file_type="image", s3_key="attachments/x.png",
        original_filename="x.png", file_size_bytes=10,
    )
    seed.db.add(attachment)
    seed.db.flush()
    # The attachment gate is checked for the roles it is written for: an admin
    # may, a viewer may not. An editor's own attachment rights are unchanged by
    # this PR and are covered where that route's own tests live.
    checks_attachment = is_admin or role == ProjectRole.viewer
    monkeypatch.setattr(
        "apps.api.services.s3_service.delete_object",
        (lambda key: None) if is_admin else (
            lambda key: pytest.fail("a viewer must not reach S3")
        ),
    )
    caller = seed.user(superadmin=is_admin)
    if not is_admin and role is not None:
        seed.member(project, caller, role)
    client = as_user(caller)
    edited = client.patch(f"/comments/{comment.id}", json={"body": "edited by admin"})
    dropped = (
        client.delete(f"/comments/{comment.id}/attachments/{attachment.id}")
        if checks_attachment else None
    )
    if not is_admin:
        assert edited.status_code == 403
        assert edited.json()["detail"] == "Can only edit your own comments"
        if dropped is not None:
            assert dropped.status_code == 403
            assert dropped.json()["detail"] == "Not authorized to delete this attachment"
        removed = client.delete(f"/comments/{comment.id}")
        assert removed.status_code == 403
        assert removed.json()["detail"] == "Can only delete your own comments"
        seed.db.refresh(comment)
        assert comment.body == "theirs"
        assert comment.deleted_at is None
        # The owner still moderates their own project, and that is no admin reach.
        assert as_user(owner).patch(
            f"/comments/{comment.id}", json={"body": "owner edit"},
        ).status_code == 200
        assert admin_log(seed.db, project.id) == []
        return
    assert edited.status_code == 200
    assert edited.json()["body"] == "edited by admin"
    assert dropped.status_code == 204
    seed.db.refresh(comment)
    assert comment.body == "edited by admin"
    # Recorded as an administrative reach, like the delete path.
    [logged] = admin_log(seed.db, project.id)
    assert logged.user_id == caller.id
    assert logged.payload["membership"] == "none"
    assert client.delete(f"/comments/{comment.id}").status_code == 204
    seed.db.refresh(comment)
    assert comment.deleted_at is not None
