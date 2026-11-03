"""The storage tab and the trash: every gate on deleting and reclaiming.

End to end over HTTP against real Postgres, because what is under test is which
rows a query matches and which status comes back; a MagicMock session answers
every query truthily, so a gate that never ran would pass. Each gate is driven
from the outside, by sending the request a browser with the gate removed would
send: a check that only lives in the dialog is a suggestion. The harness
(`seed`, `as_user`, `admin`, `s3`, `panel`) is shared, in conftest.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from apps.api.config import settings
from apps.api.models.activity import ActivityLog
from apps.api.models.asset import Asset
from apps.api.models.project import Project, ProjectRole
from apps.api.services import admin_panel
from apps.api.tasks import cleanup_tasks

RETENTION = settings.soft_delete_retention_days

GB = 1024 ** 3

# ── every endpoint is superadmin only ─────────────────────────────────────────

PANEL_WRITES = [
    ("/admin/delete", {"confirm_count": 0}),
    ("/admin/trash/restore", {}),
    ("/admin/trash/purge", {"confirm_count": 0, "confirm_bytes": 0, "everything": True}),
]


@pytest.mark.parametrize("path", ["/admin/storage", "/admin/trash"])
def test_only_a_superadmin_reads_a_panel_tab(seed, as_user, admin, path):
    assert as_user(seed.user()).get(path).status_code == 403
    assert as_user(admin).get(path).status_code == 200


@pytest.mark.parametrize(("path", "body"), PANEL_WRITES)
def test_an_ordinary_user_cannot_reach_any_panel_action(seed, as_user, path, body):
    """Refused before the gate, not by it: a non-admin never gets as far as being told
    their confirmation was wrong."""
    assert as_user(seed.user()).post(path, json=body).status_code == 403

# ── tab: storage ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("level", ["project", "asset"])
def test_trashing_moves_bytes_into_the_trash_figure_and_the_rows_still_add_up(
    seed, as_user, admin, panel, level,
):
    """One definition of used: a trashed thing's bytes are still in the bucket and move
    from the live rows to the trash figure rather than off the page. Live rows plus the
    trash figure is every committed byte, counted once."""
    owner = seed.user()
    live = seed.project(owner, name="live one")
    seed.media(live, owner, original=3_000, derived=1_000)
    binned = seed.project(owner, name="binned one")
    asset = seed.media(binned, owner, original=6_000, derived=4_000)
    # A trashed asset inside a live project, and one inside the thing being
    # trashed: the second must not be priced twice.
    seed.trash(seed.media(live, owner, name="binned child", original=500, derived=0))
    seed.trash(seed.media(binned, owner, name="child of binned", original=900, derived=0))
    client = as_user(admin)
    before = panel.summary(client)
    seed.trash(binned if level == "project" else asset)
    body = client.get("/admin/storage").json()
    assert body["summary"]["used_bytes"] == before["used_bytes"], "still in the bucket"
    assert body["summary"]["trash_bytes"] - before["trash_bytes"] == 10_000
    # Both figures come from the server, so the sentence in the header cannot
    # drift from the collector that acts on it.
    assert body["summary"]["retention_days"] == RETENTION
    rows = sum(r["total_bytes"] for r in body["projects"])
    assert rows + body["summary"]["trash_bytes"] == body["summary"]["used_bytes"]
    assert next(
        r for r in body["projects"] if r["project_id"] == str(live.id)
    )["total_bytes"] == 4_000
    if level == "project":
        # A trashed project is priced nowhere in the live rows.
        assert str(binned.id) not in {r["project_id"] for r in body["projects"]}

# ── the delete gate ───────────────────────────────────────────────────────────

def _delete(client, **body):
    return client.post("/admin/delete", json=body)


@pytest.mark.parametrize(
    ("count", "size", "phrase_needed"),
    [(1, 1_000, False), (2, 1_000, True), (1, 11 * GB, True)],
    ids=["one small project", "two projects", "one project over ten gigabytes"],
)
def test_the_typed_phrase_is_required_above_either_threshold(
    seed, as_user, admin, count, size, phrase_needed,
):
    """Two thresholds, count and size: one project can be the whole disk. The gate is on
    the server, so a browser with the field removed gets a 428."""
    owner = seed.user()
    projects = [seed.project(owner, name=f"p{n}") for n in range(count)]
    for project in projects:
        seed.media(project, owner, original=size, derived=0)
    ids = [str(p.id) for p in projects]
    client = as_user(admin)
    resp = _delete(client, project_ids=ids, confirm_count=count)
    if phrase_needed:
        assert resp.status_code == 428
        assert "DELETE" in resp.json()["detail"]
        for project in projects:
            seed.db.refresh(project)
            assert project.deleted_at is None
        resp = _delete(client, project_ids=ids, confirm_count=count, confirm_text="DELETE")
    assert resp.status_code == 200
    assert resp.json()["deleted_projects"] == count
    for project in projects:
        seed.db.refresh(project)
        assert project.deleted_at is not None


@pytest.mark.parametrize(
    "typed", [None, "", "2", "delete", "delete please", "DELETED"],
    ids=["nothing", "blank", "the count", "the lowercase word", "a sentence", "nearly"],
)
def test_the_typed_phrase_is_the_word_and_nothing_else(seed, as_user, admin, typed):
    """The count used to be accepted too, and so did the lowercase word, clearing a gate
    whose dialog says to type DELETE and whose button compares case. A gate that accepts
    what its text never asked for stops being read."""
    owner = seed.user()
    one, two = seed.project(owner, name="one"), seed.project(owner, name="two")
    resp = _delete(
        as_user(admin), project_ids=[str(one.id), str(two.id)],
        confirm_count=2, confirm_text=typed,
    )
    assert resp.status_code == 428
    seed.db.refresh(one)
    assert one.deleted_at is None


@pytest.mark.parametrize(
    "stale", [False, True], ids=["a different count", "something already gone"],
)
def test_a_confirmation_that_does_not_match_the_selection_is_refused_whole(
    seed, as_user, admin, stale,
):
    """The check a browser cannot be trusted with. A stale page is the common case, and
    deleting whatever is left of the selection is not what was confirmed."""
    owner = seed.user()
    alive = seed.project(owner, name="alive")
    ids = [str(alive.id)] + ([str(uuid.uuid4())] if stale else [])
    resp = _delete(as_user(admin), project_ids=ids, confirm_count=2, confirm_text="DELETE")
    assert resp.status_code == 409
    if stale:
        assert "no longer exist" in resp.json()["detail"]
    seed.db.refresh(alive)
    assert alive.deleted_at is None


def test_bytes_are_counted_once_when_a_project_and_its_asset_are_both_selected(
    seed, as_user, admin,
):
    """Overlapping roots used to be summed separately, which reported a reclaim of twice
    the size the disk would actually give back. An empty selection is refused outright."""
    owner = seed.user()
    project = seed.project(owner)
    asset = seed.media(project, owner, original=1_000, derived=500)
    client = as_user(admin)
    resp = _delete(
        client, project_ids=[str(project.id)], asset_ids=[str(asset.id)],
        confirm_count=2, confirm_text="DELETE",
    )
    assert resp.json()["freed_bytes"] == 1_500
    assert _delete(client, confirm_count=0).status_code == 400


def test_an_older_version_goes_alone_but_the_newest_only_with_its_asset(seed, as_user, admin):
    """Deleting the current cut on its own would quietly demote the asset to an older one;
    to lose it you delete the whole file, which says what it does."""
    owner = seed.user()
    asset = seed.media(seed.project(owner), owner, name="master", versions=3,
                       original=1_000, derived=0)
    v1, v2, newest = seed.versions_of(asset)
    client = as_user(admin)
    older = _delete(client, version_ids=[str(v1.id)], confirm_count=1)
    assert older.status_code == 200
    assert older.json()["deleted_versions"] == 1
    for v in (v1, v2, newest):
        seed.db.refresh(v)
    assert v1.deleted_at is not None
    # The current cut and everything between it are untouched.
    assert v2.deleted_at is None and newest.deleted_at is None
    refused = _delete(client, version_ids=[str(newest.id)], confirm_count=1)
    assert refused.status_code == 409
    assert "master" in refused.json()["detail"]
    seed.db.refresh(newest)
    assert newest.deleted_at is None
    allowed = _delete(
        client, asset_ids=[str(asset.id)], version_ids=[str(newest.id)],
        confirm_count=2, confirm_text="DELETE",
    )
    assert allowed.status_code == 200
    seed.db.refresh(asset)
    assert asset.deleted_at is not None

# ── restoring from the trash ──────────────────────────────────────────────────
#
# `POST /projects/{id}/restore` is the per-project half of the same window, so
# the cases that drive it live here too.

def _restore(client, **body):
    return client.post("/admin/trash/restore", json=body)


@pytest.mark.parametrize(
    ("who", "status"),
    [("owner", 200), ("admin", 200), (None, 403),
     (ProjectRole.viewer, 403), (ProjectRole.reviewer, 403), (ProjectRole.editor, 403)],
    ids=["its owner", "a superadmin who is not a member", "an outsider",
         "a viewer", "a reviewer", "an editor"],
)
def test_only_an_owner_or_a_superadmin_restores_a_project(seed, as_user, admin, who, status):
    """Before this the dialog's retention promise was true of the row and false of
    everything a person could reach. A live project has nothing to restore, which is a
    404."""
    owner = seed.user()
    project = seed.project(owner, deleted=True)
    if who == "owner":
        caller = owner
    elif who == "admin":
        caller = admin
    else:
        caller = seed.user()
        if who is not None:
            seed.member(project, caller, who)
    resp = as_user(caller).post(f"/projects/{project.id}/restore")
    assert resp.status_code == status
    seed.db.refresh(project)
    assert (project.deleted_at is None) is (status == 200)
    if status == 200:
        assert as_user(caller).post(f"/projects/{project.id}/restore").status_code == 404


def test_a_project_deleted_past_the_window_is_refused_rather_than_restored(seed, as_user):
    """Past the window the row belongs to the nightly collector, and reporting a restore
    the next pass undoes would be worse than refusing."""
    owner = seed.user()
    project = seed.project(owner, deleted=True)
    project.deleted_at = datetime.now(timezone.utc) - timedelta(days=RETENTION + 1)
    seed.db.flush()
    resp = as_user(owner).post(f"/projects/{project.id}/restore")
    assert resp.status_code == 409
    seed.db.refresh(project)
    assert project.deleted_at is not None


def test_the_panel_restores_a_project_an_asset_and_a_version_in_one_go(seed, as_user, admin):
    """Parents before children, so selecting all three together works instead of refusing
    the children for a parent that is about to come back."""
    owner = seed.user()
    project = seed.project(owner)
    asset = seed.media(project, owner, versions=2, original=1_000, derived=0)
    old_version = seed.versions_of(asset)[0]
    seed.trash(project, asset, old_version)
    resp = _restore(
        as_user(admin), project_ids=[str(project.id)], asset_ids=[str(asset.id)],
        version_ids=[str(old_version.id)],
    )
    assert resp.status_code == 200
    body = resp.json()
    assert (body["restored_projects"], body["restored_assets"], body["restored_versions"]) == (1, 1, 1)
    assert body["blocked_by_parent"] == []


@pytest.mark.parametrize("level", ["project", "asset", "version"])
def test_a_live_row_is_skipped_and_a_child_of_a_trashed_parent_is_blocked(
    seed, as_user, admin, level,
):
    """Two different answers, and the difference matters: skipped means there was nothing
    to do, blocked means restoring it would report success and leave it just as
    unreachable, then hard-delete it with its parent."""
    owner = seed.user()
    project = seed.project(owner)
    asset = seed.media(project, owner, versions=2, original=1_000, derived=0)
    version = seed.versions_of(asset)[0]
    row = {"project": project, "asset": asset, "version": version}[level]
    client = as_user(admin)
    live = _restore(client, **{f"{level}_ids": [str(row.id)]}).json()
    assert live[f"restored_{level}s"] == 0
    assert live["skipped"] == [str(row.id)]
    assert live["blocked_by_parent"] == []
    if level == "project":
        return  # a project has no parent to be blocked by
    seed.trash(project, asset, version)
    blocked = _restore(client, **{f"{level}_ids": [str(row.id)]}).json()
    assert blocked[f"restored_{level}s"] == 0
    assert blocked["blocked_by_parent"] == [str(row.id)]
    assert blocked["skipped"] == []
    seed.db.refresh(row)
    assert row.deleted_at is not None


def test_a_restored_asset_leaves_the_folder_that_is_still_in_the_trash(
    seed, as_user, admin, s3,
):
    """`DELETE /folders/{id}` stamps the folder's assets, so they appear in the trash as
    ordinary rows. Clearing `deleted_at` alone left the asset naming a trashed folder: a
    live row nobody could reach, which the collector then hard-deleted with the folder.
    One rule for both doors moves it to the project's root instead."""
    owner = seed.user()
    project = seed.project(owner)
    folder = seed.folder(project, owner, name="dailies")
    asset = seed.media(project, owner, name="in a folder", folder=folder, original=1_000)
    assert as_user(owner).delete(f"/folders/{folder.id}").status_code == 204

    assert _restore(as_user(admin), asset_ids=[str(asset.id)]).json()["restored_assets"] == 1
    seed.db.refresh(asset)
    assert asset.deleted_at is None
    assert asset.folder_id is None, "at the root, where the grid lists it"

    # Age the folder past the window and run the collector that cascaded it away.
    folder.deleted_at = datetime.now(timezone.utc) - timedelta(days=RETENTION + 1)
    seed.db.flush()
    cleanup_tasks._purge_soft_deleted(seed.db, cleanup_tasks.PurgeCounts())
    seed.db.flush()
    assert seed.db.query(Asset).filter(Asset.id == asset.id).first() is not None
    assert s3["delete_object"] == [], "its objects are not the folder's to reclaim"


@pytest.mark.parametrize("level", ["asset", "version"])
def test_an_upload_that_was_never_usable_work_is_not_restored(seed, as_user, admin, level):
    """`_dispose_version_files` deletes the objects before it stamps the row, so there is
    nothing behind an `uploading` version in the trash. Restoring it would bring back a
    card that cannot be opened, which is the same refusal `POST /assets/{id}/restore`
    gives."""
    from apps.api.models.asset import ProcessingStatus

    owner = seed.user()
    project = seed.project(owner)
    asset = seed.media(project, owner, original=1_000, status=ProcessingStatus.uploading)
    version = seed.versions_of(asset)[0]
    row = {"asset": asset, "version": version}[level]
    seed.trash(row)
    body = _restore(as_user(admin), **{f"{level}_ids": [str(row.id)]}).json()
    assert body[f"restored_{level}s"] == 0
    assert body["skipped"] == [str(row.id)]
    seed.db.refresh(row)
    assert row.deleted_at is not None


@pytest.mark.parametrize("level", ["project", "asset", "version"])
@pytest.mark.parametrize(
    ("age_days", "retention_off", "status"),
    [
        (max(RETENTION - 1, 0), False, 200),
        (900, True, 200),
        (RETENTION + 1, False, 409),
    ],
    ids=["inside the window", "the window switched off", "past the window"],
)
def test_the_retention_window_decides_the_whole_request(
    seed, as_user, admin, monkeypatch, level, age_days, retention_off, status,
):
    """Past the window the row belongs to the collector, so the whole request is refused
    rather than its old part quietly skipped; retention 0 disables the collector, and then
    nothing is on a clock. A fresh row in the same request shares its fate."""
    if retention_off:
        monkeypatch.setattr(settings, "soft_delete_retention_days", 0)
    owner = seed.user()
    project = seed.project(owner)
    asset = seed.media(project, owner, original=1_000, derived=0)
    version = seed.versions_of(asset)[0]
    row = {"project": project, "asset": asset, "version": version}[level]
    fresh = seed.project(owner, name="fresh", deleted=True)
    seed.trash(project, asset, version)
    row.deleted_at = datetime.now(timezone.utc) - timedelta(days=age_days)
    seed.db.flush()
    body = {f"{level}_ids": [str(row.id)]}
    body["project_ids"] = sorted(set(body.get("project_ids", []) + [str(fresh.id)]))
    resp = _restore(as_user(admin), **body)
    assert resp.status_code == status
    seed.db.refresh(fresh)
    if status == 409:
        assert str(RETENTION) in resp.json()["detail"]
        assert fresh.deleted_at is not None, "the whole request is refused, not part of it"
    else:
        assert fresh.deleted_at is None

# ── tab: the trash ────────────────────────────────────────────────────────────

def test_each_trash_root_carries_what_purging_it_would_free(seed, as_user, admin):
    """A root is a trashed thing whose parents are all live. Its figure is what purging
    that row frees, and the roots sum exactly to the trash total: a second number for the
    same bytes is how a list stops adding up."""
    owner = seed.user()
    live = seed.project(owner, name="live")
    binned_project = seed.project(owner, name="binned project")
    seed.media(binned_project, owner, original=7_000, derived=2_000)
    # A child of the trashed project: its bytes belong to the project above it.
    child = seed.media(binned_project, owner, name="child", original=900, derived=0)
    binned_asset = seed.media(live, owner, name="binned asset", original=3_000, derived=1_000)
    multi = seed.media(live, owner, name="multi", versions=2, original=500, derived=100)
    binned_version = seed.versions_of(multi)[0]
    seed.trash(binned_project, child, binned_asset, binned_version)
    binned_project.deleted_at = datetime.now(timezone.utc) - timedelta(days=2)
    seed.db.flush()
    body = as_user(admin).get("/admin/trash").json()
    project_row = next(p for p in body["projects"] if p["project_id"] == str(binned_project.id))
    assert project_row["total_bytes"] == 9_900, "its own bytes plus its trashed child's"
    # Each row says how long it has left before the collector takes it.
    assert project_row["days_left"] == RETENTION - 2
    assert body["retention_days"] == RETENTION
    child_row = next(a for a in body["assets"] if a["asset_id"] == str(child.id))
    assert child_row["total_bytes"] is None, "priced on the project above it"
    assert child_row["blocked_by_project"] is True
    asset_row = next(a for a in body["assets"] if a["asset_id"] == str(binned_asset.id))
    assert asset_row["total_bytes"] == 4_000
    assert asset_row["blocked_by_project"] is False
    version_row = next(v for v in body["versions"] if v["version_id"] == str(binned_version.id))
    assert version_row["total_bytes"] == 600, "a trashed version carries its own size"
    assert version_row["blocked_by_parent"] is False
    roots = sum(
        r["total_bytes"] or 0
        for r in body["projects"] + body["assets"] + body["versions"]
    )
    assert roots == body["total_bytes"], "the roots are the whole trash, counted once"


def test_a_trashed_child_is_priced_on_its_parent_and_nowhere_else(seed):
    """Only roots carry a figure: a trashed thing whose parent is also trashed is
    already counted on the parent, and a second claim on the same bytes is a double
    count. Pinned on `_trash_root_bytes` rather than through `/admin/trash`, because
    the endpoint blanks a blocked row's figure on the way out and would therefore stay
    green with the parent filters gone; the promise that each byte is claimed once
    lives in the query, and the next caller that reads the figure instead of the mask
    inherits whatever is wrong with it."""
    owner = seed.user()
    binned_project = seed.project(owner, name="binned project")
    child = seed.media(binned_project, owner, name="child", original=900, derived=0)
    # Live asset in the trashed project, holding a trashed version: its version is
    # not a root either, because the project above it is in the trash.
    live_child = seed.media(binned_project, owner, name="live child", original=700, derived=0)
    live = seed.project(owner, name="live")
    binned_asset = seed.media(live, owner, name="binned asset", original=3_000, derived=1_000)
    # Trashed asset in a live project, holding a trashed version: the version is the
    # asset's bytes, the asset is the root.
    both = seed.media(live, owner, name="both", original=300, derived=0)
    multi = seed.media(live, owner, name="multi", versions=2, original=500, derived=100)
    seed.trash(
        binned_project, child, binned_asset, both,
        seed.versions_of(live_child)[0], seed.versions_of(both)[0],
        seed.versions_of(multi)[0],
    )

    project_bytes, asset_bytes, version_bytes = admin_panel._trash_root_bytes(seed.db)

    assert project_bytes == {binned_project.id: 1_600}, "its own bytes and its children's"
    assert asset_bytes == {binned_asset.id: 4_000, both.id: 300}, \
        "the child inside the trashed project is the project's bytes"
    assert version_bytes == {seed.versions_of(multi)[0].id: 600}, \
        "a version under a trashed asset or project is the parent's bytes"

# ── emptying the trash for good ───────────────────────────────────────────────

def _purge(client, **body):
    body.setdefault("confirm_text", "DELETE")
    return client.post("/admin/trash/purge", json=body)


def _trashed_project(seed, owner, **kwargs):
    project = seed.project(owner, **kwargs)
    asset = seed.media(project, owner, original=1_000, derived=500)
    seed.trash(project)
    return project, asset


def test_emptying_the_trash_removes_the_rows_frees_the_bytes_and_the_keys(
    seed, as_user, admin, panel, s3,
):
    """Renditions and the poster included: removing the rows alone would free nothing on
    the bucket, which is why this endpoint exists."""
    owner = seed.user()
    project, asset = _trashed_project(seed, owner)
    version = seed.versions_of(asset)[0]
    client = as_user(admin)
    resp = _purge(client, everything=True, **panel.trash_counts(client))
    assert resp.status_code == 200
    assert resp.json()["purged_projects"] == 1
    assert resp.json()["freed_bytes"] == 1_500
    # Gone for good, not soft-deleted again.
    assert seed.db.query(Project).filter(Project.id == project.id).first() is None
    assert seed.db.query(Asset).filter(Asset.id == asset.id).first() is None
    # The object-store keys really go, the transcode output as one prefix.
    assert f"raw/{version.id}" in s3["delete_object"]
    assert f"processed/{version.id}/poster.jpg" in s3["delete_object"]
    assert f"processed/{version.id}/" in s3["delete_prefix"]
    # And the figures it was holding are off the header and the limit together.
    summary = panel.summary(client)
    assert summary["trash_bytes"] == 0
    assert summary["used_bytes"] == 0


@pytest.mark.parametrize(
    ("tweak", "status"),
    [
        ({"confirm_text": None}, 428),
        ({"confirm_text": "1"}, 428),
        ({"bytes_off": 1}, 409),
        ({"count_off": 98}, 409),
        ({"live": "alone"}, 409),
        ({"live": "mixed"}, 409),
    ],
    ids=["no phrase", "the count is not the word", "byte figure disagrees",
         "count disagrees", "a live project", "a mixed selection"],
)
def test_a_purge_is_refused_whole_unless_everything_about_it_matches(
    seed, as_user, admin, panel, s3, tweak, status,
):
    """Stricter than the soft delete on every axis: both figures are echoed and checked,
    and the phrase is required at every size. A live id answers 409 too, so there is no
    route from the list of active projects to an irreversible delete, and purging "the
    part that was deletable" is not what the figures described."""
    owner = seed.user()
    project, _ = _trashed_project(seed, owner)
    client = as_user(admin)
    live = tweak.pop("live", None)
    if live:
        alive = seed.project(owner, name="in daily use")
        seed.media(alive, owner)
        ids = [str(alive.id)] + ([str(project.id)] if live == "mixed" else [])
        resp = _purge(client, project_ids=ids, confirm_count=len(ids), confirm_bytes=1_500)
        if live == "alone":
            assert "not in the trash" in resp.json()["detail"]
        seed.db.refresh(alive)
        assert alive.deleted_at is None
    else:
        body = panel.trash_counts(client)
        body["confirm_bytes"] += tweak.pop("bytes_off", 0)
        body["confirm_count"] += tweak.pop("count_off", 0)
        body.update(tweak)
        resp = client.post("/admin/trash/purge", json={"everything": True, **body})
    assert resp.status_code == status
    assert seed.db.query(Project).filter(Project.id == project.id).first() is not None
    assert s3["delete_object"] == []


def test_one_trashed_root_can_be_purged_on_its_own(seed, as_user, admin, s3):
    """The same endpoint and gate with one id, so there is no second permanent-delete path
    to keep in step. An empty trash is refused rather than reported as done."""
    owner = seed.user()
    assert _purge(
        as_user(admin), everything=True, confirm_count=0, confirm_bytes=0,
    ).status_code == 400
    project = seed.project(owner)
    keep = seed.media(project, owner, name="keep", original=1_000, derived=0)
    drop = seed.media(project, owner, name="drop", original=2_000, derived=0)
    seed.trash(drop)
    client = as_user(admin)
    refused = client.post("/admin/trash/purge", json={
        "asset_ids": [str(drop.id)], "confirm_count": 1, "confirm_bytes": 2_000,
    })
    assert refused.status_code == 428, "one row still needs the phrase"
    resp = _purge(client, asset_ids=[str(drop.id)], confirm_count=1, confirm_bytes=2_000)
    assert resp.status_code == 200
    assert seed.db.query(Asset).filter(Asset.id == drop.id).first() is None
    assert seed.db.query(Asset).filter(Asset.id == keep.id).first() is not None


@pytest.mark.parametrize(
    "what", ["delete", "purge", "restore", "a restore that restored nothing"],
)
def test_every_panel_action_is_recorded_once_with_who_and_how_much(
    seed, as_user, admin, panel, s3, what,
):
    """Written without a project id for the two that take things away: the purge cascade
    deletes the activity log of the project it removes, so a pinned row would be destroyed
    by the action it records. An empty request's log line would bury the real ones exactly
    when somebody is reading the history, so it is not written at all."""
    owner = seed.user()
    client = as_user(admin)
    if what == "delete":
        project = seed.project(owner)
        seed.media(project, owner, original=1_000, derived=500)
        _delete(client, project_ids=[str(project.id)], confirm_count=1)
        action, expected = "admin_bulk_delete", 2  # one for the action, one for the project
    elif what == "purge":
        _trashed_project(seed, owner)
        _purge(client, everything=True, **panel.trash_counts(client))
        action, expected = "admin_trash_purge", 1  # the project's own row went with it
    elif what == "restore":
        project = seed.project(owner, deleted=True)
        _restore(client, project_ids=[str(project.id)])
        action, expected = "admin_restore", 2
    else:
        _restore(client, project_ids=[str(seed.project(owner).id), str(uuid.uuid4())])
        action, expected = "admin_restore", 0
    rows = seed.db.query(ActivityLog).filter(ActivityLog.action == action).all()
    assert len(rows) == expected
    assert all(r.user_id == admin.id for r in rows)
    assert all(r.payload["count"] == 1 for r in rows)
    if expected:
        [action_row] = [r for r in rows if r.project_id is None]
        if what in ("delete", "purge"):
            assert action_row.payload["bytes"] == 1_500


def test_a_restore_that_lands_between_resolving_and_purging_is_skipped(seed, as_user, admin, s3):
    """Each root is re-checked and locked immediately before cascading, so a row restored
    in between is passed over rather than destroyed on a stale read."""
    owner = seed.user()
    project, _ = _trashed_project(seed, owner)
    targets = admin_panel.trash_purge_targets(seed.db, [], [], [], everything=True)

    # The restore the panel would have issued, landing after the resolve above.
    project.deleted_at = None
    seed.db.flush()
    result = admin_panel.purge_from_trash(seed.db, targets, admin)
    assert result["purged_projects"] == 0
    assert seed.db.query(Project).filter(Project.id == project.id).first() is not None


def test_the_newest_version_gate_reads_the_one_people_see(seed, as_user, admin):
    """With v3 failed, the version people see is v2, so v2 is what may not be deleted
    alone: the gate used to read the newest by number and let a request quietly demote
    the file to v1. Same rule as `_display_version`."""
    from apps.api.models.asset import ProcessingStatus

    owner = seed.user()
    asset = seed.media(seed.project(owner), owner, name="master", versions=2,
                       original=1_000, derived=0)
    v1, v2 = seed.versions_of(asset)
    v3, _ = seed.version(asset, owner, number=3, original=1_000, derived=0,
                         status=ProcessingStatus.failed)
    client = as_user(admin)
    refused = _delete(client, version_ids=[str(v2.id)], confirm_count=1)
    assert refused.status_code == 409
    assert "master" in refused.json()["detail"]
    # The failed one is not what anybody opens, so it goes on its own.
    assert _delete(client, version_ids=[str(v3.id)], confirm_count=1).status_code == 200
    for v in (v1, v2):
        seed.db.refresh(v)
    assert (v1.deleted_at, v2.deleted_at) == (None, None)


def test_a_purge_is_refused_while_a_worker_is_still_writing(seed, as_user, admin, s3):
    """The retention window used to make this impossible: a month-old version is not in
    flight. Purging one that is loses the job and orphans whatever it writes next."""
    from apps.api.models.asset import ProcessingStatus

    owner = seed.user()
    project = seed.project(owner)
    asset = seed.asset(project, owner, name="in the oven")
    version, _ = seed.version(asset, owner, original=1_000, derived=0,
                              status=ProcessingStatus.processing, s3_keys=True)
    seed.trash(asset)
    client = as_user(admin)
    resp = _purge(client, asset_ids=[str(asset.id)], confirm_count=1, confirm_bytes=1_000)
    assert resp.status_code == 409
    assert "still being processed" in resp.json()["detail"]
    assert seed.db.query(Asset).filter(Asset.id == asset.id).first() is not None
    assert s3["delete_object"] == []
    # Finished, and the same request goes through.
    version.processing_status = ProcessingStatus.ready
    seed.db.flush()
    assert _purge(
        client, asset_ids=[str(asset.id)], confirm_count=1, confirm_bytes=1_000,
    ).status_code == 200


def test_a_purge_prices_logs_and_counts_only_what_really_happened(
    seed, as_user, admin, monkeypatch,
):
    """`freed_bytes`, the audit row and `s3_deletes` used to describe what was resolved: a
    root restored between the resolve and the lock was skipped but still priced and
    logged, and a store that refused every delete still reported those bytes as
    reclaimed. Driven through the service, because the stale-echo gate refuses the
    request long before this over HTTP, and the race is below that gate."""
    import apps.api.tasks.cleanup_tasks as ct

    owner = seed.user()
    kept, _ = _trashed_project(seed, owner, name="restored in between")
    doomed = seed.project(owner, name="really going")
    seed.media(doomed, owner, original=2_000, derived=0)
    seed.trash(doomed)
    targets = admin_panel.trash_purge_targets(seed.db, [], [], [], everything=True)
    assert len(targets["projects"]) == 2

    def refuse(_key):
        raise RuntimeError("the store is down")

    monkeypatch.setattr(ct, "delete_object", refuse)
    monkeypatch.setattr(ct, "delete_prefix", refuse)
    # The restore lands after the resolve above, before the locks below.
    kept.deleted_at = None
    seed.db.flush()

    result = admin_panel.reclaim_objects(
        seed.db, admin_panel.purge_from_trash(seed.db, targets, admin),
    )
    assert result["purged_projects"] == 1
    assert result["freed_bytes"] == 2_000, "only the root that cascaded is priced"
    assert result["s3_deletes"] == 0, "nothing was really reclaimed"
    assert result["s3_failures"] > 0
    [row] = seed.db.query(ActivityLog).filter(
        ActivityLog.action == "admin_trash_purge",
    ).all()
    assert [p["name"] for p in row.payload["projects"]] == ["really going"]
    assert (row.payload["count"], row.payload["bytes"]) == (1, 2_000)
    assert (row.payload["s3_deletes"], row.payload["s3_failures"]) == (0, result["s3_failures"])
    assert seed.db.query(Project).filter(Project.id == kept.id).first() is not None


def test_the_objects_go_only_after_the_rows_are_committed(seed, as_user, admin, s3):
    """The cascade used to delete the objects inside the request's transaction, so a
    process dying partway left the rows rolled back, still inside the window, and
    `/admin/trash/restore` would bring them back with their media already gone. Now the
    keys are collected, the caller commits, and `reclaim_objects` sends them."""
    owner = seed.user()
    project, asset = _trashed_project(seed, owner)
    version = seed.versions_of(asset)[0]
    targets = admin_panel.trash_purge_targets(seed.db, [], [], [], everything=True)

    pending = admin_panel.purge_from_trash(seed.db, targets, admin)
    assert seed.db.query(Project).filter(Project.id == project.id).first() is None
    assert (s3["delete_object"], s3["delete_prefix"]) == ([], []), "not sent before the commit"
    assert (pending["s3_deletes"], pending["s3_failures"]) == (0, 0)

    admin_panel.reclaim_objects(seed.db, pending)
    assert f"raw/{version.id}" in s3["delete_object"]
    assert f"processed/{version.id}/" in s3["delete_prefix"]
    assert pending["s3_deletes"] > 0 and pending["s3_failures"] == 0


def test_the_endpoint_commits_the_rows_before_it_reclaims_the_objects(
    seed, as_user, admin, panel, s3, monkeypatch,
):
    """The test above pins the service halves in isolation; this pins the order the
    endpoint calls them in, which is the whole safety property. Swapping `db.commit()`
    and `reclaim_objects` in `routers/admin.py` leaves every other purge test green,
    because the end state is identical -- only a crash between the two tells them
    apart. So watch the calls rather than the result: the commit has to be what
    immediately precedes the reclaim."""
    owner = seed.user()
    _trashed_project(seed, owner)
    client = as_user(admin)
    confirmation = panel.trash_counts(client)

    calls = []
    # The `live_db` fixture already shadows `commit` on the instance (it flushes, so
    # endpoint writes stay inside the test's transaction), so the spy has to wrap that
    # instance attribute; patching the class would never be reached.
    real_commit, real_reclaim = seed.db.commit, admin_panel.reclaim_objects

    def spy_commit(*args, **kwargs):
        calls.append("commit")
        return real_commit(*args, **kwargs)

    def spy_reclaim(db, pending):
        calls.append("reclaim")
        return real_reclaim(db, pending)

    monkeypatch.setattr(seed.db, "commit", spy_commit)
    monkeypatch.setattr(admin_panel, "reclaim_objects", spy_reclaim)

    assert _purge(client, everything=True, **confirmation).status_code == 200

    assert calls.count("reclaim") == 1, "the endpoint reclaims exactly once"
    at = calls.index("reclaim")
    assert at > 0 and calls[at - 1] == "commit", \
        f"the rows must be committed before the objects go, got {calls}"


def test_a_project_restore_is_recorded_as_a_reach_into_the_project(seed, as_user, admin):
    """A superadmin who is not a member can do this, so the project's own history has to
    say it happened; the panel's bulk restore logged it and this door did not."""
    owner = seed.user()
    project = seed.project(owner, deleted=True)
    assert as_user(admin).post(f"/projects/{project.id}/restore").status_code == 200
    rows = seed.db.query(ActivityLog).filter(
        ActivityLog.action == "project_restored",
    ).all()
    assert len(rows) == 1
    assert (rows[0].project_id, rows[0].user_id) == (project.id, admin.id)
    assert rows[0].payload["by_superadmin"] is True
