"""Tests for the retention-window cascade GC (issue #65 core)."""
import uuid
from datetime import datetime, timezone, timedelta

import apps.api.tasks.cleanup_tasks as ct
from apps.api.models.user import User
from apps.api.models.project import Project, ProjectType
from apps.api.models.folder import Folder
from apps.api.models.asset import (
    Asset, AssetType, AssetVersion, MediaFile, CarouselItem, FileType, ProcessingStatus,
)
from apps.api.models.comment import Comment, Annotation, CommentAttachment, CommentReaction
from apps.api.models.approval import Approval, ApprovalStatus
from apps.api.models.share import ShareLink, ShareLinkItem, ShareLinkActivity, AssetShare, ShareActivityAction
from apps.api.models.metadata import MetadataField, AssetMetadata, Collection, CollectionShare, FieldType
from apps.api.models.branding import ProjectBranding, WatermarkSettings
from apps.api.models.activity import Mention, ActivityLog, Notification, NotificationType


# ── seed helpers (module-level; extended by later tasks) ─────────────────────────

def _user(db):
    u = User(email=f"gc-{uuid.uuid4()}@t.local", name="t")
    db.add(u); db.flush()
    return u


def _project(db, owner, deleted_hours_ago=None):
    p = Project(name="t", project_type=ProjectType.personal, created_by=owner.id)
    db.add(p); db.flush()
    if deleted_hours_ago is not None:
        p.deleted_at = datetime.now(timezone.utc) - timedelta(hours=deleted_hours_ago)
        db.flush()
    return p


def _asset(db, project, owner, folder=None, deleted_hours_ago=None):
    a = Asset(project_id=project.id, name="t", asset_type=AssetType.video, created_by=owner.id,
              folder_id=(folder.id if folder else None))
    db.add(a); db.flush()
    if deleted_hours_ago is not None:
        a.deleted_at = datetime.now(timezone.utc) - timedelta(hours=deleted_hours_ago)
        db.flush()
    return a


def _version(db, asset, owner, status=ProcessingStatus.ready, deleted_hours_ago=None):
    v = AssetVersion(asset_id=asset.id, version_number=1, processing_status=status, created_by=owner.id)
    db.add(v); db.flush()
    if deleted_hours_ago is not None:
        v.deleted_at = datetime.now(timezone.utc) - timedelta(hours=deleted_hours_ago)
        db.flush()
    return v


def _comment(db, asset, version, owner, parent=None):
    c = Comment(asset_id=asset.id, version_id=version.id, author_id=owner.id, body="hi",
                parent_id=(parent.id if parent else None))
    db.add(c); db.flush()
    return c


def test_purge_comment_removes_subtree_and_attachment_s3(real_db, monkeypatch):
    deleted = []
    monkeypatch.setattr(ct, "delete_object", lambda k: deleted.append(k))
    monkeypatch.setattr(ct, "delete_prefix", lambda k: deleted.append(k))

    owner = _user(real_db)
    project = _project(real_db, owner)
    asset = _asset(real_db, project, owner)
    version = _version(real_db, asset, owner)
    parent = _comment(real_db, asset, version, owner)
    reply = _comment(real_db, asset, version, owner, parent=parent)
    real_db.add(Annotation(comment_id=parent.id, drawing_data={}))
    real_db.add(CommentAttachment(comment_id=parent.id, file_type="image", s3_key="att/x",
                                  original_filename="a.png", file_size_bytes=1))
    real_db.add(CommentReaction(comment_id=parent.id, user_id=owner.id, emoji="👍"))
    real_db.add(Mention(comment_id=parent.id, mentioned_user_id=owner.id))
    real_db.add(Notification(user_id=owner.id, type=NotificationType.comment,
                             asset_id=asset.id, comment_id=parent.id))
    real_db.flush()

    counts = ct.PurgeCounts()
    ct._purge_comment(real_db, parent.id, counts)

    assert real_db.query(Comment).filter(Comment.id.in_([parent.id, reply.id])).count() == 0
    assert real_db.query(Annotation).filter_by(comment_id=parent.id).count() == 0
    assert real_db.query(CommentAttachment).filter_by(comment_id=parent.id).count() == 0
    assert real_db.query(CommentReaction).filter_by(comment_id=parent.id).count() == 0
    assert real_db.query(Mention).filter_by(comment_id=parent.id).count() == 0
    assert real_db.query(Notification).filter_by(comment_id=parent.id).count() == 0
    assert "att/x" in deleted
    assert counts.comments == 2  # parent + reply
