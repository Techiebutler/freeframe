"""Measuring storage: derived bytes, the backfill, and one definition of "used".

The bytes a transcode produces (HLS renditions, the single-file MP4/MP3/WebP,
the poster, the waveform) were in the bucket and nowhere in the database, so the
overview would have had to list S3 on every page view. Pinned here: one listing
per job, bounded, and a failed listing never fails a transcode; the backfill
touches only never-measured rows, measures the trash the figure counts, never
overwrites a measurement, pages, cannot run twice at once and gives up on a
store that is down; NULL is "not measured yet", never a zero folded into a
total; and one definition of used storage across the header, the project row,
the member indicator and the upload guard.

The sums run against real Postgres: a grouped SUM over joins is the whole
feature and the mock session cannot execute one. `AGENTS.md` has people run the
suite against a development database, so nothing here assumes an empty one:
assertions on instance-wide counters either scope to the rows the test seeded or
start from a baseline the test takes first.
"""
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import text

import apps.api.routers.admin as admin_module
from apps.api.models.asset import AssetType, ProcessingStatus
from apps.api.services import admin_panel, s3_service, storage as storage_service
from apps.api.tasks import storage_tasks

# ── who may read the overview ─────────────────────────────────────────────────

ADMIN_ONLY = [
    ("get", "/admin/storage"),
    ("get", f"/admin/storage/projects/{uuid.uuid4()}"),
    ("post", "/admin/storage/backfill"),
]


@pytest.mark.parametrize(("method", "path"), ADMIN_ONLY)
@pytest.mark.parametrize(
    "signed_in", [True, False], ids=["a non-admin", "no credentials at all"],
)
def test_the_overview_endpoints_are_superadmin_only(
    client, auth_headers, mock_db, test_user, method, path, signed_in,
):
    """Both doors, and they are different doors. The `auth_headers` fixture installs a
    `get_current_user` override, which an unauthenticated case has to take off again or
    it only repeats the signed-in non-admin path with no header attached."""
    from apps.api.main import app
    from apps.api.middleware.auth import get_current_user

    test_user.is_superadmin = False
    if signed_in:
        kwargs = {"headers": auth_headers}
        expected = 403
    else:
        app.dependency_overrides.pop(get_current_user, None)
        kwargs = {}
        expected = 401
    resp = getattr(client, method)(path, **kwargs)
    assert resp.status_code == expected


def test_the_backfill_trigger_enqueues_the_task_on_the_maintenance_queue(
    client, auth_headers, mock_db, test_user, monkeypatch,
):
    """A listing per unmeasured version belongs behind the housekeeping queue, not in front
    of a transcode. An unknown project is a 404, because an empty list would read as "this
    project holds nothing", a different answer from "there is no such project"."""
    from apps.api.tasks.celery_app import celery_app
    test_user.is_superadmin = True
    calls = []
    monkeypatch.setattr(admin_module, "send_task_safe", lambda task, *a, **k: calls.append(task))
    resp = client.post("/admin/storage/backfill", headers=auth_headers)
    assert resp.status_code == 202
    assert resp.json()["status"] == "started"
    assert admin_module.backfill_media_derived_size in calls
    assert celery_app.conf.task_routes["backfill_media_derived_size"] == {"queue": "maintenance"}
    mock_db.first.return_value = None
    assert client.get(
        f"/admin/storage/projects/{uuid.uuid4()}", headers=auth_headers,
    ).status_code == 404

# ── measuring one version's output ────────────────────────────────────────────

@pytest.mark.parametrize(
    ("listing", "expected"),
    [
        ([("a/1080p.m3u8", None, 120), ("a/seg000.ts", None, 2_000_000),
          ("a/thumb.jpg", None, 48_000)], 2_048_120),
        ([], 0),
    ],
    ids=["sums one listing", "nothing is zero"],
)
def test_prefix_size_bytes_sums_exactly_one_listing(monkeypatch, listing, expected):
    """One listing per job: this is the call the overview would otherwise make per view."""
    listed = []
    monkeypatch.setattr(
        s3_service, "list_keys",
        lambda prefix, client=None: (listed.append(prefix), iter(listing))[1],
    )
    assert s3_service.prefix_size_bytes("processed/p/a/v") == expected
    assert listed == ["processed/p/a/v"]


def test_the_measurement_listings_are_bounded_and_the_sweep_keeps_the_shared_client(
    monkeypatch,
):
    """A store that hangs rather than refuses must fail the one listing, not hold a
    finished transcode or a whole backfill for boto3's default minute per attempt. The
    orphan sweep's own listings keep the unbounded shared client they have always used,
    so bounding this one changes nothing for them."""
    cfg = s3_service._get_listing_client().meta.config
    assert (cfg.connect_timeout, cfg.read_timeout) == (5, 10)
    assert cfg.retries["total_max_attempts"] == 3
    # boto3's untouched defaults, which is what a measurement must not inherit.
    assert s3_service.get_s3_client().meta.config.read_timeout == 60

    used = []
    monkeypatch.setattr(
        s3_service, "list_keys",
        lambda prefix, client=None: (used.append(client), iter([]))[1],
    )
    s3_service.prefix_size_bytes("processed/p/a/v")
    assert used == [s3_service._get_listing_client()]


@pytest.mark.parametrize(
    "fails", [False, True], ids=["stores what it wrote", "failure is not fatal"],
)
def test_the_transcode_records_its_output_and_survives_a_failed_listing(monkeypatch, fails):
    """The output is already in the bucket, so a transcode must not be marked failed
    because the bookkeeping listing timed out. The row stays unmeasured until somebody
    runs the backfill; nothing picks it up on its own."""
    from unittest.mock import MagicMock
    from apps.api.tasks import transcode_tasks
    media_file = MagicMock(derived_size_bytes=None, version_id=uuid.uuid4())
    db = MagicMock()

    def _size(prefix):
        if fails:
            raise RuntimeError("ListObjectsV2 timed out")
        return 7_777_777
    monkeypatch.setattr("apps.api.services.s3_service.prefix_size_bytes", _size)
    transcode_tasks._record_derived_size(db, media_file, "processed/p/a/v")
    assert media_file.derived_size_bytes == (None if fails else 7_777_777)
    assert db.flush.called is not fails


def test_process_asset_measures_before_it_marks_the_version_ready(monkeypatch):
    """Order matters: `ready` is what makes a version count towards storage, so the
    measurement has to be on the row before the status flips, in the same commit, at
    the prefix the transcoder writes to. Every status change goes into the same list as
    the transcode and the measurement, so swapping the two lines fails here."""
    from unittest.mock import MagicMock
    from apps.api.tasks import transcode_tasks
    order = []

    class _RecordingVersion:
        """A version row that writes each status change into `order`."""

        id: uuid.UUID
        processing_status: ProcessingStatus

        def __init__(self):
            self.id = uuid.uuid4()
            object.__setattr__(self, "processing_status", ProcessingStatus.uploading)

        def __setattr__(self, name, value):
            if name == "processing_status":
                order.append(("status", value))
            object.__setattr__(self, name, value)

    version = _RecordingVersion()
    asset = MagicMock(id=uuid.uuid4(), project_id=uuid.uuid4(), asset_type=AssetType.image)
    media_file = MagicMock(derived_size_bytes=None, version_id=version.id)
    db = MagicMock()
    db.query.return_value.filter.return_value.first.side_effect = [version, asset, media_file]
    monkeypatch.setattr(
        transcode_tasks, "_record_derived_size",
        lambda _db, mf, prefix: order.append(("measured", prefix)),
    )
    monkeypatch.setattr(
        transcode_tasks, "_process_image", lambda *a, **k: order.append(("transcoded",)),
    )
    monkeypatch.setattr(transcode_tasks, "_publish_event", lambda *a, **k: True)
    monkeypatch.setattr(transcode_tasks, "SessionLocal", lambda: db)
    monkeypatch.setattr("apps.api.services.s3_service.get_s3_client", lambda: MagicMock())
    transcode_tasks.process_asset.run(str(asset.id), str(version.id))
    assert [o[0] for o in order] == ["status", "transcoded", "measured", "status"]
    assert [o[1] for o in order if o[0] == "status"] == [
        ProcessingStatus.processing, ProcessingStatus.ready,
    ]
    assert order[2][1] == storage_tasks.output_prefix_for(
        asset.project_id, asset.id, version.id,
    ) == f"processed/{asset.project_id}/{asset.id}/{version.id}"

# ── the backfill ──────────────────────────────────────────────────────────────

@pytest.fixture
def backfill(seed, monkeypatch):
    """The backfill task wired to the test's own session, plus a way to say what each
    listing returns. Returns `(run, sizes)`."""
    monkeypatch.setattr(storage_tasks, "SessionLocal", lambda: seed.db)
    # The outer transaction rolls back, so the task's commits are flushes and
    # its close is a no-op; the fixture owns the connection.
    monkeypatch.setattr(seed.db, "commit", seed.db.flush)
    monkeypatch.setattr(seed.db, "close", lambda: None)

    def _sizes(fn):
        monkeypatch.setattr("apps.api.services.s3_service.prefix_size_bytes", fn)
    return storage_tasks.backfill_media_derived_size, _sizes


@pytest.fixture
def drained(backfill):
    """`backfill`, with whatever the database already held measured as zero first.

    So a test can assert on the task's instance-wide counters and mean its own rows.
    A development database has unmeasured media in it, and these counters have no
    project to scope to; measuring it away inside the test's transaction is cheaper
    than carrying a baseline through every assertion. Rolled back with the test.
    """
    run, sizes = backfill
    sizes(lambda prefix: 0)
    run.run(pause_seconds=0)
    return run, sizes


def test_the_backfill_measures_only_null_rows_is_idempotent_and_records_a_zero(seed, drained):
    """0 is the true answer for a version that produced no output; leaving it NULL would
    make every later run list the same prefix again."""
    run, sizes = drained
    owner = seed.user()
    project = seed.project(owner)
    asset = seed.asset(project, owner)
    _, unmeasured = seed.version(asset, owner, 1, derived=None)
    _, already = seed.version(asset, owner, 2, derived=500)
    _, empty = seed.version(asset, owner, 3, derived=None)
    mine = {
        f"processed/{project.id}/{asset.id}/{unmeasured.version_id}": 3_000_000,
        f"processed/{project.id}/{asset.id}/{empty.version_id}": 0,
    }
    listed = []
    sizes(lambda p: listed.append(p) or mine[p])
    assert run.run(pause_seconds=0) == {"measured": 2, "failed": 0, "bytes": 3_000_000}
    seed.db.expire_all()
    assert unmeasured.derived_size_bytes == 3_000_000
    assert already.derived_size_bytes == 500, "a measured row is never re-listed"
    assert empty.derived_size_bytes == 0, "a measured zero, not left NULL"
    assert sorted(listed) == sorted(mine)

    # Idempotent: a second run finds nothing left to measure and lists nothing.
    assert run.run(pause_seconds=0) == {"measured": 0, "failed": 0, "bytes": 0}
    assert len(listed) == 2, "nothing listed twice"


def test_the_backfill_measures_the_trash_because_the_figures_count_it(seed, drained):
    """`committed_media` counts a soft-deleted project, asset or version, because its
    objects are still in the bucket and the upload limit still blocks on them. A backfill
    that skipped them left `unmeasured_files` above zero after a complete run, kept their
    derived bytes out of `used` and `trash_bytes`, and handed a restored asset back as
    NULL."""
    run, sizes = drained
    owner = seed.user()
    project = seed.project(owner)
    binned_asset = seed.asset(project, owner, name="binned asset", deleted=True)
    _, on_binned_asset = seed.version(binned_asset, owner, 1, derived=None)
    live_asset = seed.asset(project, owner, name="live asset")
    _, binned_version = seed.version(live_asset, owner, 1, derived=None, deleted=True)
    mine = {
        f"processed/{project.id}/{binned_asset.id}/{on_binned_asset.version_id}": 11,
        f"processed/{project.id}/{live_asset.id}/{binned_version.version_id}": 22,
    }
    sizes(lambda p: mine[p])
    assert run.run(pause_seconds=0) == {"measured": 2, "failed": 0, "bytes": 33}
    seed.db.expire_all()
    assert (on_binned_asset.derived_size_bytes, binned_version.derived_size_bytes) == (11, 22)
    # The count the trigger's response tells people to watch really reaches zero,
    # and the trashed bytes are in the figure that offers to free them.
    assert storage_service.instance_storage_totals(seed.db)["unmeasured_files"] == 0
    assert admin_panel.storage_summary(seed.db)["trash_bytes"] >= 33


def test_a_batch_never_overwrites_a_measurement_taken_while_it_ran(seed, drained):
    """The rows are selected, then the listings happen, then the write lands, so a
    transcode finishing inside that window used to lose its own figure to this run's
    older listing, and the row was never re-measured. The write is conditional on the row
    still being NULL, which also makes a row purged mid-batch a no-op rather than a
    StaleDataError."""
    run, sizes = drained
    owner = seed.user()
    project = seed.project(owner)
    asset = seed.asset(project, owner)
    _, racing = seed.version(asset, owner, 1, derived=None)
    _, purged = seed.version(asset, owner, 2, derived=None)
    racing_prefix = f"processed/{project.id}/{asset.id}/{racing.version_id}"
    purged_prefix = f"processed/{project.id}/{asset.id}/{purged.version_id}"

    def _meanwhile(prefix):
        if prefix == racing_prefix:
            # A transcode of this version finishes while this listing is in flight.
            seed.db.execute(
                text("UPDATE media_files SET derived_size_bytes = 4242 WHERE id = :i"),
                {"i": racing.id},
            )
        if prefix == purged_prefix:
            # An admin purge reaches this row while this listing is in flight.
            seed.db.execute(
                text("DELETE FROM media_files WHERE id = :i"), {"i": purged.id},
            )
        return 1
    sizes(_meanwhile)
    assert run.run(pause_seconds=0) == {"measured": 0, "failed": 0, "bytes": 0}
    assert seed.db.execute(
        text("SELECT derived_size_bytes FROM media_files WHERE id = :i"), {"i": racing.id},
    ).scalar() == 4242, "the transcode's own figure was overwritten"


def test_a_failed_listing_neither_stops_the_run_nor_makes_the_paging_loop(
    seed, drained, monkeypatch,
):
    """A row whose listing failed stays NULL. Paging on the NULL filter alone would hand it
    out again and again; the keyset moves past it, and the rest of the run still gets
    measured. The failures alternate, so this run ends on the keyset and not on the
    consecutive-failure breaker."""
    run, sizes = drained
    owner = seed.user()
    project = seed.project(owner)
    asset = seed.asset(project, owner)
    files = [seed.version(asset, owner, n, derived=None)[1] for n in range(1, 7)]
    mine = {
        f"processed/{project.id}/{asset.id}/{f.version_id}": n
        for n, f in enumerate(files, 1)
    }
    monkeypatch.setattr(storage_tasks, "BATCH_SIZE", 2)
    calls = {"n": 0}

    def _flaky(prefix):
        calls["n"] += 1
        if calls["n"] > 2 * len(mine):
            # Not an AssertionError: the task catches `Exception` around the
            # listing, which would swallow one and hang instead of failing.
            pytest.fail("the backfill is looping over the same rows")
        if mine[prefix] % 2:
            raise RuntimeError("ListObjectsV2 refused")
        return 900
    sizes(_flaky)
    assert run.run(pause_seconds=0) == {"measured": 3, "failed": 3, "bytes": 2_700}
    seed.db.expire_all()
    assert [f.derived_size_bytes for f in files] == [None, 900, None, 900, None, 900]


def test_the_backfill_gives_up_after_consecutive_failed_listings(seed, backfill, monkeypatch):
    """A store that is down fails every listing, and carrying on would spend one bounded
    request per remaining row to learn the same thing. Consecutive, so the alternating
    failures above do not trip it."""
    run, sizes = backfill
    owner = seed.user()
    asset = seed.asset(seed.project(owner), owner)
    for n in range(1, 11):
        seed.version(asset, owner, n, derived=None)
    monkeypatch.setattr(storage_tasks, "MAX_CONSECUTIVE_LISTING_FAILURES", 3)
    monkeypatch.setattr(storage_tasks, "BATCH_SIZE", 2)
    tried = []

    def _down(prefix):
        tried.append(prefix)
        raise RuntimeError("the object store is not answering")
    sizes(_down)
    assert run.run(pause_seconds=0) == {
        "measured": 0, "failed": 3, "bytes": 0, "stopped": "listing_failures",
    }
    assert len(tried) == 3, "it kept listing after it had given up"


def test_the_backfill_pages_honours_a_limit_and_never_skips_a_tied_timestamp(
    seed, drained, monkeypatch,
):
    """`.all()` with no limit put every unmeasured row in memory at once, and `limit` is
    None in exactly the normal case, because the endpoint enqueues the task without one.
    `created_at` is not unique, so the keyset carries the id as a tie-break."""
    run, sizes = drained
    owner = seed.user()
    asset = seed.asset(seed.project(owner), owner)
    files = [seed.version(asset, owner, n, derived=None)[1] for n in range(1, 8)]
    for f in files:
        f.created_at = datetime(2026, 10, 28, 9, 0, tzinfo=timezone.utc)
    seed.db.flush()
    monkeypatch.setattr(storage_tasks, "BATCH_SIZE", 2)
    sizes(lambda p: 10)
    batches = []
    real_rows = storage_tasks.unmeasured_media_rows

    def _counting(db_, limit=None, after=None):
        rows = real_rows(db_, limit, after)
        batches.append((limit, len(rows)))
        return rows
    monkeypatch.setattr(storage_tasks, "unmeasured_media_rows", _counting)
    assert run.run(pause_seconds=0) == {"measured": 7, "failed": 0, "bytes": 70}
    # Never more than a batch at a time, and the last short page ends the loop;
    # no row sharing the one timestamp is handed out twice or skipped.
    assert batches == [(2, 2), (2, 2), (2, 2), (2, 1)]
    seed.db.expire_all()
    assert all(f.derived_size_bytes == 10 for f in files)
    for n in range(8, 15):
        seed.version(asset, owner, n, derived=None)
    assert run.run(limit=3, pause_seconds=0) == {"measured": 3, "failed": 0, "bytes": 30}


def test_a_second_run_is_skipped_while_one_holds_the_lock(seed, backfill):
    """Every call to the trigger enqueues a run; two runs listing the same prefixes would
    pay twice for the same answer."""
    from apps.api.database import engine
    run, sizes = backfill
    owner = seed.user()
    seed.version(seed.asset(seed.project(owner), owner), owner, 1, derived=None)
    sizes(lambda p: pytest.fail("the skipped run must not list"))
    other = engine.connect()
    key = {"k": storage_tasks._BACKFILL_ADVISORY_LOCK_KEY}
    try:
        other.execute(text("SELECT pg_advisory_lock(:k)"), key)
        result = run.run(pause_seconds=0)
    finally:
        other.execute(text("SELECT pg_advisory_unlock(:k)"), key)
        other.close()
    assert result == {"measured": 0, "failed": 0, "bytes": 0, "skipped": True}


def test_the_advisory_lock_is_held_on_a_connection_of_its_own(seed, backfill):
    """A session-scoped advisory lock belongs to the Postgres backend that took it, and a
    pooled `Session` hands its connection back on every commit, so this task's per-batch
    commits could put the lock and the unlock on two different backends and a failed flush
    could skip the unlock altogether. Held on a connection of its own, neither is
    possible: the lock is never on the backend the session is using."""
    from apps.api.database import engine
    run, sizes = backfill
    owner = seed.user()
    seed.version(seed.asset(seed.project(owner), owner), owner, 1, derived=None)
    session_pid = seed.db.execute(text("SELECT pg_backend_pid()")).scalar()
    watcher = engine.connect()
    holders = []

    def _watch(prefix):
        holders.extend(watcher.execute(
            text(
                "SELECT pid FROM pg_locks "
                "WHERE locktype = 'advisory' AND classid = 0 AND objid = :k"
            ),
            {"k": storage_tasks._BACKFILL_ADVISORY_LOCK_KEY},
        ).scalars().all())
        return 0
    sizes(_watch)
    try:
        run.run(pause_seconds=0)
        # Released, so the next run is not locked out by this one.
        assert watcher.execute(
            text("SELECT pg_try_advisory_lock(:k)"),
            {"k": storage_tasks._BACKFILL_ADVISORY_LOCK_KEY},
        ).scalar() is True
        watcher.execute(
            text("SELECT pg_advisory_unlock(:k)"),
            {"k": storage_tasks._BACKFILL_ADVISORY_LOCK_KEY},
        )
    finally:
        watcher.close()
    assert holders, "the run took no advisory lock at all"
    assert session_pid not in holders, "the lock is on the session's own connection"

# ── what the figures mean ─────────────────────────────────────────────────────

def _row(db, project):
    return next(r for r in storage_service.project_storage_rows(db) if r["project_id"] == project.id)


def test_only_committed_bytes_count_and_a_null_is_never_summed_as_zero(seed):
    """Only `processing`/`ready` versions of live assets count, exactly as
    `instance_storage_used_bytes` counts them, or the overview and the upload guard would
    disagree about the same instance. A NULL would claim bytes the bucket does not hold,
    so it is reported as a count of unmeasured files instead."""
    owner = seed.user()
    project = seed.project(owner)
    asset = seed.asset(project, owner)
    seed.version(asset, owner, 1, original=1_000, derived=10)
    seed.version(asset, owner, 2, original=500, derived=20, status=ProcessingStatus.processing)
    seed.version(asset, owner, 3, original=300, derived=None)
    seed.version(asset, owner, 4, original=9_000_000_000, derived=30,
                 status=ProcessingStatus.uploading)
    seed.version(asset, owner, 5, original=8_888, derived=40, status=ProcessingStatus.failed)
    seed.version(asset, owner, 6, original=7_777, derived=50, deleted=True)
    seed.version(seed.asset(project, owner, deleted=True), owner, 1, original=6_666, derived=60)
    row = _row(seed.db, project)
    assert (row["original_bytes"], row["derived_bytes"], row["total_bytes"]) == (1_800, 30, 1_830)
    assert (row["unmeasured_files"], row["asset_count"]) == (1, 1)
    assert row["total_bytes"] == storage_service.project_storage_used_bytes(seed.db, project.id)

    # Rows come back largest first, and a project holding nothing is not a row.
    empty = seed.project(owner, name="empty")
    sized = {}
    for name, original in (("small", 100), ("big", 500_000), ("mid", 50_000)):
        other = seed.project(owner, name=name)
        sized[name] = other
        seed.version(seed.asset(other, owner), owner, 1, original=original, derived=0)
    ids = [r["project_id"] for r in storage_service.project_storage_rows(seed.db)]
    assert [i for i in ids if i in {p.id for p in sized.values()}] == [
        sized["big"].id, sized["mid"].id, sized["small"].id,
    ]
    assert empty.id not in ids


def test_the_project_file_rows_are_assets_largest_first_and_versions_newest_first(seed):
    """What `GET /admin/storage/projects/{id}` serves. The smaller asset is seeded first,
    so the order the sums arrive in is not the expected order and the asset sort is
    load-bearing; the newest version is the larger one here, so `is_latest` and the
    version order pin "which cut is current" rather than "which transcoded biggest".
    An unmeasured file is its original alone, never a claimed zero."""
    owner = seed.user()
    project = seed.project(owner)
    small = seed.asset(project, owner, name="small asset")
    big = seed.asset(project, owner, name="big asset")
    seed.version(small, owner, 1, original=500, derived=None, filename="tiny.mp4")
    seed.version(big, owner, 1, original=90_000, derived=9_000, filename="v1.mp4")
    seed.version(big, owner, 2, original=10_000, derived=1_000, filename="v2.mp4")
    rows = admin_panel.storage_asset_rows(seed.db, project.id)
    assert [a["name"] for a in rows] == ["big asset", "small asset"]
    assert rows[0]["total_bytes"] == 110_000
    assert [
        (v["version_number"], v["total_bytes"], v["is_latest"]) for v in rows[0]["versions"]
    ] == [(2, 11_000, True), (1, 99_000, False)]
    [only] = rows[1]["versions"]
    assert (rows[1]["total_bytes"], only["total_bytes"], only["is_latest"]) == (500, 500, True)
    assert admin_panel.storage_asset_rows(seed.db, seed.project(owner).id) == []

# ── one definition, across every surface that quotes it ───────────────────────
#
# The bug this pins, measured. The panel header added derived bytes to the
# originals, the upload guard counted the originals alone, and the member
# indicator on `GET /instance/settings` showed the originals again. Three
# visible numbers for one bucket against one capacity, so with a cap of 10,000,
# originals of 6,000 and 4,000 derived bytes the header said "10.0 KB of 10.0 KB
# used, 0 B free" while the next 3,000-byte upload was still accepted.

@pytest.mark.parametrize(
    ("original", "derived", "cap", "binned"),
    [
        (6_000, 4_000, 10_000, False),   # full on the two together, the reported case
        (6_000, 4_000, 12_000, False),   # room left for 2,000
        (10_000, 0, 10_000, False),      # full on originals alone
        (0, 0, 10_000, False),           # empty
        (6_000, 5_000, 10_000, False),   # over the cap already
        (6_000, 4_000, 10_000, True),    # in the trash, and still in the bucket
        (6_000, None, 10_000, False),    # not measured yet
    ],
)
def test_no_free_space_in_the_header_means_exactly_a_refused_upload(
    seed, as_user, original, derived, cap, binned,
):
    """The biconditional the panel promises: the header reports 0 free if and only if the
    guard refuses the next byte, checked both ways round, so neither a header that
    under-reports nor a guard that over-accepts can pass. `GET /instance/settings` is the
    same capacity on a member's screen, so it cannot be a third number.

    The biconditional and the free-space arithmetic hold whatever else the database
    holds, because both sides read the same figure; the two counters that are about this
    test's own rows are deltas on a baseline taken before it seeds."""
    base = admin_panel.storage_summary(seed.db)
    admin = seed.user(superadmin=True)
    owner = seed.user()
    seed.limit(cap)
    project = seed.project(owner, name="scoped")
    if original or derived:
        seed.media(project, owner, original=original, derived=derived)
    if binned:
        seed.trash(project)
    summary = as_user(admin).get("/admin/storage").json()["summary"]
    free = summary["free_bytes"]
    guard_refuses = storage_service.storage_cap_error(seed.db, 1) is not None
    assert (free == 0) == guard_refuses, (
        f"header free={free}, guard refuses one byte={guard_refuses}"
    )
    assert summary["unmeasured_files"] - base["unmeasured_files"] == (
        1 if derived is None else 0
    )
    assert summary["trash_bytes"] - base["trash_bytes"] == (
        10_000 if binned else 0
    ), "the trash keeps its bytes"
    # The member indicator and the service agree with the panel, to the byte.
    assert as_user(owner).get("/instance/settings").json()["storage_used_bytes"] == (
        summary["used_bytes"]
    ) == storage_service.instance_storage_used_bytes(seed.db)
    if summary["used_bytes"] <= cap:
        # The free figure is bytes the guard really takes, down to the last one.
        assert free == cap - summary["used_bytes"]
        assert storage_service.storage_cap_error(seed.db, free) is None
        assert storage_service.storage_cap_error(seed.db, free + 1) is not None
    else:
        # Already over the cap: the header floors free at 0 rather than printing
        # a negative, and nothing at all goes through, not even nothing.
        assert free == 0
        assert storage_service.storage_cap_error(seed.db, 0) is not None


def test_a_project_figure_and_its_admin_row_count_the_same_bytes(seed):
    """One definition per project as well: the project's own figure and the row in the
    storage panel are one query with one filter on it, so a measured project cannot show
    two sizes. Instance-wide the trash still counts, and the total is the originals plus
    the measured output and nothing else.
    """
    before = storage_service.instance_storage_totals(seed.db)
    owner = seed.user()
    project = seed.project(owner, name="measured")
    seed.media(project, owner, name="live", original=3_000, derived=1_000)
    seed.trash(seed.media(project, owner, name="binned", original=7_000, derived=2_000))
    assert storage_service.project_storage_used_bytes(seed.db, project.id) == 4_000
    assert _row(seed.db, project)["total_bytes"] == 4_000
    totals = storage_service.instance_storage_totals(seed.db)
    assert totals["used_bytes"] == totals["original_bytes"] + totals["derived_bytes"]
    assert totals["used_bytes"] - before["used_bytes"] == 13_000
    assert storage_service.instance_storage_used_bytes(seed.db) == totals["used_bytes"]


def test_the_project_endpoints_quote_the_one_storage_definition(seed, as_user):
    """The batched query behind `GET /projects` and the single-project figure are the same
    definition the admin row uses, not a hand-rolled copy: a measured project cannot show
    one size in a list and another on its own page."""
    owner = seed.user()
    project = seed.project(owner, name="measured")
    seed.media(project, owner, name="live", original=3_000, derived=1_000)
    seed.trash(seed.media(project, owner, name="binned", original=7_000, derived=2_000))
    client = as_user(owner)
    listed = next(p for p in client.get("/projects").json() if p["id"] == str(project.id))
    assert listed["storage_bytes"] == 4_000
    assert client.get(f"/projects/{project.id}").json()["storage_bytes"] == 4_000
    assert storage_service.project_storage_used_bytes(seed.db, project.id) == 4_000
