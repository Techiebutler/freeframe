"""Real-Postgres integration tests for committed-only storage usage.

The default harness (`conftest.py`) fully mocks the DB session, so it cannot execute the
SUM/join/filter in `instance_storage_used_bytes` / `project_storage_used_bytes`. These tests
run against a real Postgres (CI provides a service; local dev provides the stack) inside a
transaction that is always rolled back — no rows persist.
"""
import uuid
from datetime import datetime, timezone

import pytest  # noqa: F401  (real_db fixture now lives in conftest.py)

from apps.api.models.user import User
from apps.api.models.project import Project, ProjectType
from apps.api.models.asset import (
    Asset, AssetType, AssetVersion, MediaFile, FileType, ProcessingStatus,
)
from apps.api.services.storage import (
    instance_storage_used_bytes, project_storage_used_bytes,
)


def _user(db) -> User:
    u = User(email=f"itest-{uuid.uuid4()}@test.local", name="itest")
    db.add(u)
    db.flush()
    return u


def _project(db, owner) -> Project:
    p = Project(name="itest", project_type=ProjectType.personal, created_by=owner.id)
    db.add(p)
    db.flush()
    return p


def _asset(db, project, owner, deleted=False) -> Asset:
    a = Asset(
        project_id=project.id, name="itest", asset_type=AssetType.video, created_by=owner.id,
        deleted_at=datetime.now(timezone.utc) if deleted else None,
    )
    db.add(a)
    db.flush()
    return a


def _version_with_file(db, asset, owner, version_number, status, size, version_deleted=False):
    v = AssetVersion(
        asset_id=asset.id, version_number=version_number, processing_status=status,
        created_by=owner.id, deleted_at=datetime.now(timezone.utc) if version_deleted else None,
    )
    db.add(v)
    db.flush()
    mf = MediaFile(
        version_id=v.id, file_type=FileType.video, original_filename="f.mp4",
        mime_type="video/mp4", file_size_bytes=size, s3_key_raw=f"raw/{v.id}",
    )
    db.add(mf)
    db.flush()
    return v


def test_committed_only_counts_ready_and_processing(real_db):
    db = real_db
    owner = _user(db)
    project = _project(db, owner)
    asset = _asset(db, project, owner)

    baseline = instance_storage_used_bytes(db)  # pre-existing committed bytes (0 in a fresh CI DB)

    # Counted: ready 1000 + processing 500 = 1500
    _version_with_file(db, asset, owner, 1, ProcessingStatus.ready, 1000)
    _version_with_file(db, asset, owner, 2, ProcessingStatus.processing, 500)
    # Excluded: uploading (also 9 GB — proves file_size_bytes BigInteger holds > 2^31), failed, deleted version
    _version_with_file(db, asset, owner, 3, ProcessingStatus.uploading, 9_000_000_000)
    _version_with_file(db, asset, owner, 4, ProcessingStatus.failed, 8888)
    _version_with_file(db, asset, owner, 5, ProcessingStatus.ready, 7777, version_deleted=True)

    # Per-project sum: exact (fresh project)
    assert project_storage_used_bytes(db, project.id) == 1500
    # Instance-wide sum: delta (independent of any pre-existing data)
    assert instance_storage_used_bytes(db) - baseline == 1500


def test_soft_deleted_asset_excluded(real_db):
    db = real_db
    owner = _user(db)
    project = _project(db, owner)
    deleted_asset = _asset(db, project, owner, deleted=True)
    _version_with_file(db, deleted_asset, owner, 1, ProcessingStatus.ready, 5000)

    assert project_storage_used_bytes(db, project.id) == 0
