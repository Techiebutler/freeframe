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
