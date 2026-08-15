"""The reaper aborts multipart uploads from its own rows, not from a bucket listing.

The old sweep listed every in-progress upload in the bucket and aborted anything
older than the cutoff, with no reference to the database. That aborted uploads that
were still transferring, because it aged them by when the multipart was *initiated*;
and on MinIO it found nothing at all after a restart, because the listing there is a
node-local in-memory cache.
"""
import uuid
from datetime import datetime, timezone, timedelta

import pytest

from apps.api.models.asset import ProcessingStatus


def _seed(db, status, created_shift_hours, *, upload_id="u-1", activity_shift_hours=None):
    from apps.api.models.user import User
    from apps.api.models.project import Project, ProjectType
    from apps.api.models.asset import Asset, AssetType, AssetVersion, MediaFile, FileType

    owner = User(email=f"sw-{uuid.uuid4()}@t.local", name="t")
    db.add(owner); db.flush()
    project = Project(name="t", project_type=ProjectType.personal, created_by=owner.id)
    db.add(project); db.flush()
    asset = Asset(project_id=project.id, name="t", asset_type=AssetType.video,
                  created_by=owner.id)
    db.add(asset); db.flush()
    v = AssetVersion(asset_id=asset.id, version_number=1, processing_status=status,
                     created_by=owner.id, upload_id=upload_id)
    db.add(v); db.flush()
    v.created_at = datetime.now(timezone.utc) - timedelta(hours=created_shift_hours)
    if activity_shift_hours is not None:
        v.last_activity_at = datetime.now(timezone.utc) - timedelta(hours=activity_shift_hours)
    key = f"raw/{v.id}/original.mp4"
    db.add(MediaFile(version_id=v.id, file_type=FileType.video, original_filename="f.mp4",
                     mime_type="video/mp4", file_size_bytes=1, s3_key_raw=key))
    db.flush()
    return v, key


@pytest.fixture
def sweep(monkeypatch):
    """Records what the reaper aborts, and lets a test drive the bucket listing."""
    from apps.api.tasks import cleanup_tasks as ct

    aborted, listing = [], []
    monkeypatch.setattr(ct, "abort_multipart_upload", lambda k, u: aborted.append((k, u)))
    monkeypatch.setattr(ct, "delete_object", lambda k: None)
    monkeypatch.setattr(ct, "delete_prefix", lambda k: None)
    monkeypatch.setattr(ct, "list_stale_multipart_uploads", lambda cutoff: list(listing))
    return ct, aborted, listing


def test_a_stale_version_has_its_own_upload_aborted(real_db, sweep):
    ct, aborted, _ = sweep
    v, key = _seed(real_db, ProcessingStatus.uploading, 48, upload_id="upload-abc")

    ct._reap_stale_uploads(real_db)

    assert (key, "upload-abc") in aborted


def test_an_upload_still_making_progress_is_not_aborted(real_db, sweep):
    """The regression that mattered: ageing by initiate time killed live uploads.

    A 90 GB master on a slow line outlives a 24h window while transferring fine.
    """
    ct, aborted, _ = sweep
    v, key = _seed(real_db, ProcessingStatus.uploading, 48, activity_shift_hours=0)

    ct._reap_stale_uploads(real_db)

    assert aborted == []
    assert v.deleted_at is None


def test_nothing_is_aborted_for_a_version_with_no_recorded_upload(real_db, sweep):
    """Rows predating the column: NULL means unknown, so there is nothing to abort."""
    ct, aborted, _ = sweep
    _seed(real_db, ProcessingStatus.uploading, 48, upload_id=None)

    ct._reap_stale_uploads(real_db)

    assert aborted == []


def test_the_sweep_no_longer_depends_on_the_bucket_listing(real_db, sweep):
    """On MinIO the listing returns nothing after a restart; the sweep must still work."""
    ct, aborted, listing = sweep
    listing.clear()  # backend reports no in-progress uploads at all
    v, key = _seed(real_db, ProcessingStatus.uploading, 48, upload_id="upload-xyz")

    ct._reap_stale_uploads(real_db)

    assert (key, "upload-xyz") in aborted
    assert v.deleted_at is not None


# ------------------------------------------------------------------ orphan pass

def test_an_upload_no_row_owns_is_aborted(real_db, sweep):
    """A commit that failed after CreateMultipartUpload leaves exactly this."""
    ct, aborted, listing = sweep
    listing.append(("raw/orphaned/original.mp4", "upload-orphan"))

    ct._reap_stale_uploads(real_db)

    assert ("raw/orphaned/original.mp4", "upload-orphan") in aborted


def test_the_orphan_pass_never_touches_an_upload_the_database_owns(real_db, sweep):
    """This is the defect the old sweep had: aborting something still referenced.

    The version here is recent and must survive, even though the backend reports
    its upload as old enough to reclaim.
    """
    ct, aborted, listing = sweep
    v, key = _seed(real_db, ProcessingStatus.uploading, 1)
    listing.append((key, "u-1"))

    ct._reap_stale_uploads(real_db)

    assert aborted == []
    assert v.deleted_at is None


def test_a_backend_that_cannot_list_uploads_does_not_break_the_sweep(real_db, sweep, monkeypatch):
    ct, aborted, _ = sweep

    def boom(cutoff):
        raise RuntimeError("ListMultipartUploads not implemented")

    monkeypatch.setattr(ct, "list_stale_multipart_uploads", boom)
    v, key = _seed(real_db, ProcessingStatus.uploading, 48, upload_id="upload-def")

    ct._reap_stale_uploads(real_db)

    # The row-driven half still did its work.
    assert (key, "upload-def") in aborted
    assert v.deleted_at is not None
