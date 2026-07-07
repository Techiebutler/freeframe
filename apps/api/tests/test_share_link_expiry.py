"""Tests for share-link expiry: the conservative expire sweep + enforcement regression (#65)."""
import uuid
from datetime import datetime, timezone, timedelta

import apps.api.tasks.cleanup_tasks as ct
from apps.api.config import settings
from apps.api.models.user import User
from apps.api.models.project import Project, ProjectType
from apps.api.models.share import ShareLink


def _owner(db):
    u = User(email=f"exp-{uuid.uuid4()}@t.local", name="t")
    db.add(u); db.flush()
    return u


def _link(db, owner, project, expires_days_ago=None):
    link = ShareLink(token=f"tok-{uuid.uuid4()}", created_by=owner.id, project_id=project.id)
    db.add(link); db.flush()
    if expires_days_ago is not None:
        link.expires_at = datetime.now(timezone.utc) - timedelta(days=expires_days_ago)
        db.flush()
    return link


def test_expire_share_links_sweeps_only_long_expired(real_db, monkeypatch):
    monkeypatch.setattr(settings, "soft_delete_retention_days", 30)
    owner = _owner(real_db)
    project = Project(name="t", project_type=ProjectType.personal, created_by=owner.id)
    real_db.add(project); real_db.flush()

    long_expired = _link(real_db, owner, project, expires_days_ago=40)   # > 30 → soft-delete
    recently_expired = _link(real_db, owner, project, expires_days_ago=5)  # < 30 → keep editable
    never_expires = _link(real_db, owner, project, expires_days_ago=None)

    counts = ct.PurgeCounts()
    ct._expire_share_links(real_db, counts)

    # _expire_share_links mutates these same ORM objects in-session — assert directly (no refresh,
    # which would reload the uncommitted rows from the DB and reset deleted_at to NULL).
    assert long_expired.deleted_at is not None
    assert recently_expired.deleted_at is None
    assert never_expires.deleted_at is None
    assert counts.share_links_expired == 1


def test_expire_share_links_disabled_when_zero(monkeypatch):
    from apps.api.tests.conftest import _make_mock_db
    monkeypatch.setattr(settings, "soft_delete_retention_days", 0)
    db = _make_mock_db()
    counts = ct.PurgeCounts()
    ct._expire_share_links(db, counts)
    db.query.assert_not_called()
