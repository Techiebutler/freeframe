"""Tests for the S3 orphan sweeper (issue #110)."""
import uuid
from datetime import datetime, timezone, timedelta

import apps.api.tasks.cleanup_tasks as ct
from apps.api.config import settings
from apps.api.models.user import User
from apps.api.models.project import Project, ProjectType
from apps.api.models.asset import Asset, AssetType, AssetVersion, MediaFile, FileType, ProcessingStatus


def _seed_media(db):
    u = User(email=f"orph-{uuid.uuid4()}@t.local", name="t"); db.add(u); db.flush()
    p = Project(name="t", project_type=ProjectType.personal, created_by=u.id); db.add(p); db.flush()
    a = Asset(project_id=p.id, name="t", asset_type=AssetType.video, created_by=u.id); db.add(a); db.flush()
    v = AssetVersion(asset_id=a.id, version_number=1, processing_status=ProcessingStatus.ready, created_by=u.id); db.add(v); db.flush()
    raw = f"raw/{p.id}/{a.id}/{v.id}/original.mp4"
    mf = MediaFile(version_id=v.id, file_type=FileType.video, original_filename="f.mp4", mime_type="video/mp4",
                   file_size_bytes=100, s3_key_raw=raw,
                   s3_key_processed=f"processed/{p.id}/{a.id}/{v.id}",
                   s3_key_thumbnail=f"processed/{p.id}/{a.id}/{v.id}/thumb0.jpg")
    db.add(mf); db.flush()
    return str(p.id), str(a.id), str(v.id), raw


def _run(db, monkeypatch, all_keys, grace=24, delete=False):
    monkeypatch.setattr(settings, "orphan_sweep_grace_hours", grace)
    monkeypatch.setattr(settings, "orphan_sweep_delete", delete)
    deleted = []
    monkeypatch.setattr(ct, "delete_object", lambda k: deleted.append(k))
    monkeypatch.setattr(ct, "list_keys", lambda prefix: [(k, lm, s) for (k, lm, s) in all_keys if k.startswith(prefix)])
    counts = ct._sweep_orphan_s3(db)
    return counts, deleted


def test_orphan_sweep_reports_only_true_orphans(real_db, monkeypatch):
    pid, aid, vid, raw = _seed_media(real_db)
    old = datetime.now(timezone.utc) - timedelta(hours=48)
    recent = datetime.now(timezone.utc) - timedelta(hours=1)
    all_keys = [
        (raw, old, 100),                                              # live raw -> not orphan
        (f"processed/{pid}/{aid}/{vid}/720p/seg001.ts", old, 200),    # HLS segment under live prefix -> not orphan
        (f"processed/{pid}/{aid}/{vid}/thumb0.jpg", old, 10),         # live thumbnail -> not orphan
        ("raw/dead-proj/dead-asset/dead-ver/original.mp4", old, 500), # genuine orphan
        ("processed/ghost/ghost/ghost/master.m3u8", recent, 300),     # unknown but RECENT -> skipped (grace)
    ]
    counts, deleted = _run(real_db, monkeypatch, all_keys, grace=24, delete=False)
    assert counts.orphans == 1 and counts.orphan_bytes == 500
    assert counts.deleted == 0 and deleted == []                      # report-only


def test_orphan_sweep_deletes_only_orphan_when_enabled(real_db, monkeypatch):
    pid, aid, vid, raw = _seed_media(real_db)
    old = datetime.now(timezone.utc) - timedelta(hours=48)
    all_keys = [
        (raw, old, 100),
        (f"processed/{pid}/{aid}/{vid}/720p/seg001.ts", old, 200),
        ("raw/dead/dead/dead/original.mp4", old, 500),
    ]
    counts, deleted = _run(real_db, monkeypatch, all_keys, grace=24, delete=True)
    assert counts.deleted == 1
    assert deleted == ["raw/dead/dead/dead/original.mp4"]             # only the orphan; live keys untouched


def test_orphan_sweep_disabled_when_grace_zero(mock_db, monkeypatch):
    monkeypatch.setattr(settings, "orphan_sweep_grace_hours", 0)
    called = []
    monkeypatch.setattr(ct, "list_keys", lambda prefix: called.append(prefix) or [])
    counts = ct._sweep_orphan_s3(mock_db)
    assert counts.orphans == 0 and called == []                      # never listed the bucket


def test_orphan_sweep_safety_abort_on_empty_live_set(mock_db, monkeypatch):
    """Fix B: if the live-set is EMPTY (0 MediaFile rows — e.g. DATABASE_URL points at the wrong/empty
    DB) but keys were scanned, deletion must be refused even with ORPHAN_SWEEP_DELETE=true — otherwise
    every object in the bucket would be treated as an orphan and wiped."""
    old = datetime.now(timezone.utc) - timedelta(hours=48)
    all_keys = [
        ("raw/some-proj/some-asset/some-ver/original.mp4", old, 500),
        ("processed/some-proj/some-asset/some-ver/master.m3u8", old, 300),
    ]
    # mock_db.all() defaults to [] -> db.query(MediaFile...).all() returns [] -> empty live-set.
    counts, deleted = _run(mock_db, monkeypatch, all_keys, grace=24, delete=True)

    assert deleted == []
    assert counts.deleted == 0
    assert counts.orphans == 2  # still correctly reports what was scanned


# ─────────────────────────── hardening the floor before widening the sweep (#115)

def test_safe_says_whether_the_op_actually_happened():
    """`_safe` swallows failures by design, so its caller cannot otherwise tell.

    The orphan sweep counts what it reclaimed, and that number is what an operator
    reads to decide the bucket is clean. Counting attempts rather than successes
    reports storage as freed that is still being paid for.
    """
    def ok(_key): return None

    def boom(_key): raise RuntimeError("S3 said no")

    assert ct._safe(ok, "k") is True
    assert ct._safe(boom, "k") is False


def test_a_delete_that_fails_is_not_counted_as_reclaimed(real_db, monkeypatch):
    pid, aid, vid, raw = _seed_media(real_db)
    old = datetime.now(timezone.utc) - timedelta(hours=48)
    all_keys = [
        (raw, old, 100),
        (f"processed/{pid}/{aid}/{vid}/720p/seg001.ts", old, 200),
        ("raw/dead/dead/dead/a.mp4", old, 500),
        ("raw/dead/dead/dead/b.mp4", old, 500),
    ]
    monkeypatch.setattr(settings, "orphan_sweep_grace_hours", 24)
    monkeypatch.setattr(settings, "orphan_sweep_delete", True)
    monkeypatch.setattr(ct, "list_keys",
                        lambda prefix: [k for k in all_keys if k[0].startswith(prefix)])

    def half_broken(key):
        if key.endswith("b.mp4"):
            raise RuntimeError("AccessDenied")

    monkeypatch.setattr(ct, "delete_object", half_broken)
    counts = ct._sweep_orphan_s3(real_db)

    assert counts.orphans == 2      # both were identified
    assert counts.deleted == 1      # only one actually went
    # and the byte figure follows the deletes, not the findings: reporting the
    # full orphan total on the success line is reporting storage as freed that
    # is still being paid for, which is the same defect as counting attempts.
    assert counts.orphan_bytes == 1000   # what was found
    assert counts.deleted_bytes == 500   # what was actually reclaimed


def test_a_live_set_too_small_for_the_bucket_refuses_to_delete(real_db, monkeypatch, caplog):
    """The gap the empty-live-set guard leaves open.

    One surviving MediaFile row against a bucket full of keys is the signature of a
    wrong or half-migrated database, and it is not an empty live-set, so the existing
    guard waves it through and every other key is deleted as an orphan.
    """
    pid, aid, vid, raw = _seed_media(real_db)
    old = datetime.now(timezone.utc) - timedelta(hours=48)
    all_keys = [(raw, old, 100)] + [
        (f"raw/other-{i}/other/other/original.mp4", old, 100) for i in range(9)
    ]
    counts, deleted = _run(real_db, monkeypatch, all_keys, grace=24, delete=True)

    assert counts.orphans == 9                 # still reported honestly
    assert deleted == [] and counts.deleted == 0
    assert "SAFETY ABORT" in caplog.text


def test_an_ordinary_sweep_is_not_blocked_by_the_floor(real_db, monkeypatch):
    """The floor has to leave normal operation alone, or it will simply be turned off."""
    pid, aid, vid, raw = _seed_media(real_db)
    old = datetime.now(timezone.utc) - timedelta(hours=48)
    all_keys = [(raw, old, 100)] + [
        (f"processed/{pid}/{aid}/{vid}/720p/seg{i:03d}.ts", old, 10) for i in range(9)
    ] + [("raw/dead/dead/dead/original.mp4", old, 500)]
    counts, deleted = _run(real_db, monkeypatch, all_keys, grace=24, delete=True)

    assert counts.orphans == 1 and counts.deleted == 1
    assert deleted == ["raw/dead/dead/dead/original.mp4"]


# ──────────────────── the prefixes the sweep did not cover (#115 item 1, #247)

def _seed_owners(db):
    """One live object under each newly swept prefix, and the rows that own them."""
    import uuid as _uuid
    from apps.api.models.branding import ProjectBranding
    from apps.api.models.instance_branding import InstanceBranding
    from apps.api.models.comment import Comment, CommentAttachment

    u = User(email=f"own-{_uuid.uuid4()}@t.local", name="t", avatar_url="avatars/u1/live.png")
    db.add(u); db.flush()
    p = Project(name="t", project_type=ProjectType.personal, created_by=u.id,
                poster_s3_key=f"posters/{_uuid.uuid4()}/poster.jpg")
    db.add(p); db.flush()
    db.add(ProjectBranding(project_id=p.id, logo_s3_key=f"branding/{p.id}/logo/live.webp"))
    db.add(InstanceBranding(logo_light_key="branding/light/live", favicon_key="branding/favicon/live"))
    a = Asset(project_id=p.id, name="t", asset_type=AssetType.video, created_by=u.id)
    db.add(a); db.flush()
    v = AssetVersion(asset_id=a.id, version_number=1,
                     processing_status=ProcessingStatus.ready, created_by=u.id)
    db.add(v); db.flush()
    c = Comment(asset_id=a.id, version_id=v.id, author_id=u.id, body="t", visibility="public")
    db.add(c); db.flush()
    db.add(CommentAttachment(comment_id=c.id, file_type="image/png", original_filename="f.png",
                             file_size_bytes=1, s3_key=f"comment-attachments/{c.id}/x/f.png"))
    db.flush()
    return u, p


def test_a_key_owned_by_a_row_outside_media_files_is_not_an_orphan(real_db, monkeypatch):
    """The gap this closes: four prefixes were written and never swept, so an
    object whose owning row was deleted was paid for forever. Widening the sweep
    means every one of them needs a liveness rule, and getting one wrong deletes
    live objects rather than leaking them, which is why the ratio floor from the
    previous change went in first."""
    u, p = _seed_owners(real_db)
    old = datetime.now(timezone.utc) - timedelta(hours=48)
    live = [
        "avatars/u1/live.png",
        p.poster_s3_key,
        f"branding/{p.id}/logo/live.webp",
        "branding/light/live",
        "branding/favicon/live",
    ]
    attachment = real_db.query(ct.CommentAttachment).first().s3_key
    all_keys = [(k, old, 10) for k in live + [attachment]]

    counts, deleted = _run(real_db, monkeypatch, all_keys, grace=24, delete=True)

    assert counts.scanned == len(all_keys)   # they are being looked at now
    assert counts.orphans == 0               # and every one is recognised
    assert deleted == []


def test_an_unowned_key_under_a_newly_swept_prefix_is_an_orphan(real_db, monkeypatch):
    u, p = _seed_owners(real_db)
    old = datetime.now(timezone.utc) - timedelta(hours=48)
    attachment = real_db.query(ct.CommentAttachment).first().s3_key
    ghosts = [
        "avatars/ghost/gone.png",
        "posters/ghost/poster.jpg",
        "comment-attachments/ghost/x/f.png",
        "branding/ghost/logo/gone.webp",
    ]
    # Six live against four orphans keeps the ratio under the 0.5 ceiling, so the
    # delete pass runs and `deleted` says exactly which keys went.
    live = ["avatars/u1/live.png", p.poster_s3_key, f"branding/{p.id}/logo/live.webp",
            "branding/light/live", "branding/favicon/live", attachment]
    all_keys = [(k, old, 10) for k in live] + [(k, old, 500) for k in ghosts]

    counts, deleted = _run(real_db, monkeypatch, all_keys, grace=24, delete=True)

    assert counts.orphans == 4
    assert sorted(deleted) == sorted(ghosts)   # and nothing live went with them


def test_watermark_images_are_never_swept(real_db, monkeypatch):
    """`branding/{project}/watermark/` has no owning column anywhere: the upload
    endpoint returns a key nothing stores, and `WatermarkContent` has no image
    variant, so the feature is half-built. Sweeping it would delete objects the
    sweeper cannot tell apart from ones an instance is using via the API
    directly, so the sub-path is excluded until that is settled."""
    _seed_owners(real_db)
    old = datetime.now(timezone.utc) - timedelta(hours=48)
    all_keys = [
        ("avatars/u1/live.png", old, 10),
        ("branding/some-project/watermark/mark.png", old, 500),
    ]
    counts, deleted = _run(real_db, monkeypatch, all_keys, grace=24, delete=True)

    assert counts.orphans == 0
    assert deleted == []


def test_watermark_output_is_all_orphan(real_db, monkeypatch):
    """#247. `apply_watermark` writes `watermarked/{asset}/output.*` and nothing
    in the codebase ever reads it back, so every object under that prefix is
    dead weight rather than something with a missing owner."""
    u, p = _seed_owners(real_db)
    old = datetime.now(timezone.utc) - timedelta(hours=48)
    attachment = real_db.query(ct.CommentAttachment).first().s3_key
    # Enough live keys to stay under the orphan-ratio ceiling, so the delete pass
    # runs at all: three orphans against one live key is 75% and the floor from
    # the previous change correctly refuses that.
    live = ["avatars/u1/live.png", p.poster_s3_key, f"branding/{p.id}/logo/live.webp",
            "branding/light/live", "branding/favicon/live", attachment]
    all_keys = [(k, old, 10) for k in live] + [
        (f"watermarked/asset-{i}/output.mp4", old, 100) for i in range(3)
    ]
    counts, deleted = _run(real_db, monkeypatch, all_keys, grace=24, delete=True)

    assert counts.orphans == 3
    assert sorted(deleted) == sorted(f"watermarked/asset-{i}/output.mp4" for i in range(3))
