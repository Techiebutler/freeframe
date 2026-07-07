"""Tests for the retention-window cascade GC (issue #65 core)."""
import uuid
from datetime import datetime, timezone, timedelta

import apps.api.tasks.cleanup_tasks as ct
from apps.api.models.user import User
from apps.api.models.project import Project, ProjectType, ProjectMember
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


def _media(db, version, ftype=FileType.video, processed="processed/x/", thumb="thumb/x"):
    mf = MediaFile(version_id=version.id, file_type=ftype, original_filename="f.mp4",
                   mime_type="video/mp4", file_size_bytes=10, s3_key_raw=f"raw/{version.id}",
                   s3_key_processed=processed, s3_key_thumbnail=thumb)
    db.add(mf); db.flush()
    return mf


def test_purge_version_removes_media_carousel_and_s3(real_db, monkeypatch):
    deleted = []
    monkeypatch.setattr(ct, "delete_object", lambda k: deleted.append(k))
    monkeypatch.setattr(ct, "delete_prefix", lambda k: deleted.append(k))

    owner = _user(real_db)
    project = _project(real_db, owner)
    asset = _asset(real_db, project, owner)
    version = _version(real_db, asset, owner)
    mf = _media(real_db, version)
    real_db.add(CarouselItem(version_id=version.id, media_file_id=mf.id, position=0))
    comment = _comment(real_db, asset, version, owner)
    real_db.add(Approval(asset_id=asset.id, version_id=version.id, user_id=owner.id,
                         status=ApprovalStatus.approved))
    real_db.flush()

    counts = ct.PurgeCounts()
    ct._purge_version(real_db, version.id, counts)

    assert real_db.query(AssetVersion).filter_by(id=version.id).count() == 0
    assert real_db.query(MediaFile).filter_by(version_id=version.id).count() == 0
    assert real_db.query(CarouselItem).filter_by(version_id=version.id).count() == 0
    assert real_db.query(Comment).filter_by(version_id=version.id).count() == 0
    assert real_db.query(Approval).filter_by(version_id=version.id).count() == 0
    assert real_db.query(Asset).filter_by(id=asset.id).count() == 1  # asset untouched
    assert set(deleted) == {f"raw/{version.id}", "processed/x/", "thumb/x"}
    assert counts.versions == 1 and counts.media_files == 1


def _share_link(db, owner, asset=None, folder=None, project=None):
    link = ShareLink(token=f"tok-{uuid.uuid4()}", created_by=owner.id,
                     asset_id=(asset.id if asset else None),
                     folder_id=(folder.id if folder else None),
                     project_id=(project.id if project else None))
    db.add(link); db.flush()
    return link


def test_purge_share_link_removes_items_activity_watermark(real_db):
    owner = _user(real_db)
    project = _project(real_db, owner)
    asset = _asset(real_db, project, owner)
    link = _share_link(real_db, owner, asset=asset)
    real_db.add(ShareLinkItem(share_link_id=link.id, asset_id=asset.id))
    real_db.add(ShareLinkActivity(share_link_id=link.id, action=ShareActivityAction.opened,
                                  actor_email="x@t.local"))
    real_db.add(WatermarkSettings(project_id=project.id, share_link_id=link.id))
    real_db.flush()

    counts = ct.PurgeCounts()
    ct._purge_share_link(real_db, link.id, counts)

    assert real_db.query(ShareLink).filter_by(id=link.id).count() == 0
    assert real_db.query(ShareLinkItem).filter_by(share_link_id=link.id).count() == 0
    assert real_db.query(ShareLinkActivity).filter_by(share_link_id=link.id).count() == 0
    assert real_db.query(WatermarkSettings).filter_by(share_link_id=link.id).count() == 0
    assert counts.share_links == 1


def test_purge_asset_removes_full_subtree(real_db, monkeypatch):
    monkeypatch.setattr(ct, "delete_object", lambda k: None)
    monkeypatch.setattr(ct, "delete_prefix", lambda k: None)

    owner = _user(real_db)
    project = _project(real_db, owner)
    asset = _asset(real_db, project, owner)
    version = _version(real_db, asset, owner)
    _media(real_db, version)
    field = MetadataField(project_id=project.id, name="f", field_type=FieldType.text)
    real_db.add(field); real_db.flush()
    real_db.add(AssetMetadata(asset_id=asset.id, field_id=field.id, value={"v": 1}))
    link = _share_link(real_db, owner, asset=asset)
    other_link = _share_link(real_db, owner, project=project)
    real_db.add(ShareLinkItem(share_link_id=other_link.id, asset_id=asset.id))  # cross-link ref
    real_db.add(AssetShare(asset_id=asset.id, shared_with_user_id=owner.id, shared_by=owner.id))
    real_db.add(ActivityLog(asset_id=asset.id, action="created"))
    real_db.add(Notification(user_id=owner.id, type=NotificationType.assignment, asset_id=asset.id))
    real_db.flush()

    counts = ct.PurgeCounts()
    ct._purge_asset(real_db, asset.id, counts)

    assert real_db.query(Asset).filter_by(id=asset.id).count() == 0
    assert real_db.query(AssetVersion).filter_by(asset_id=asset.id).count() == 0
    assert real_db.query(AssetMetadata).filter_by(asset_id=asset.id).count() == 0
    assert real_db.query(ShareLink).filter_by(id=link.id).count() == 0
    assert real_db.query(ShareLinkItem).filter_by(asset_id=asset.id).count() == 0
    assert real_db.query(AssetShare).filter_by(asset_id=asset.id).count() == 0
    assert real_db.query(ActivityLog).filter_by(asset_id=asset.id).count() == 0
    assert real_db.query(Notification).filter_by(asset_id=asset.id).count() == 0
    assert real_db.query(ShareLink).filter_by(id=other_link.id).count() == 1  # project link survives
    assert counts.assets == 1


def _folder(db, project, owner, parent=None):
    f = Folder(project_id=project.id, name=f"fld-{uuid.uuid4()}", created_by=owner.id,
               parent_id=(parent.id if parent else None))
    db.add(f); db.flush()
    return f


def test_purge_folder_recurses_nested_and_assets(real_db, monkeypatch):
    monkeypatch.setattr(ct, "delete_object", lambda k: None)
    monkeypatch.setattr(ct, "delete_prefix", lambda k: None)

    owner = _user(real_db)
    project = _project(real_db, owner)
    root = _folder(real_db, project, owner)
    nested = _folder(real_db, project, owner, parent=root)
    a_root = _asset(real_db, project, owner, folder=root)
    a_nested = _asset(real_db, project, owner, folder=nested)
    _version(real_db, a_nested, owner)
    link = _share_link(real_db, owner, folder=root)

    counts = ct.PurgeCounts()
    ct._purge_folder(real_db, root.id, counts)

    assert real_db.query(Folder).filter(Folder.id.in_([root.id, nested.id])).count() == 0
    assert real_db.query(Asset).filter(Asset.id.in_([a_root.id, a_nested.id])).count() == 0
    assert real_db.query(ShareLink).filter_by(id=link.id).count() == 0
    assert counts.folders == 2 and counts.assets == 2


def test_purge_project_removes_everything(real_db, monkeypatch):
    deleted = []
    monkeypatch.setattr(ct, "delete_object", lambda k: deleted.append(k))
    monkeypatch.setattr(ct, "delete_prefix", lambda k: deleted.append(k))

    owner = _user(real_db)
    project = _project(real_db, owner)
    project.poster_s3_key = "posters/p.webp"; real_db.flush()
    folder = _folder(real_db, project, owner)
    foldered = _asset(real_db, project, owner, folder=folder)
    loose = _asset(real_db, project, owner)
    _version(real_db, loose, owner)
    real_db.add(ProjectBranding(project_id=project.id, logo_s3_key="branding/logo.png"))
    real_db.add(WatermarkSettings(project_id=project.id))
    real_db.add(ProjectMember(project_id=project.id, user_id=owner.id))
    coll = Collection(project_id=project.id, name="c", created_by=owner.id)
    real_db.add(coll); real_db.flush()
    real_db.add(CollectionShare(collection_id=coll.id, token=f"c-{uuid.uuid4()}", created_by=owner.id))
    field = MetadataField(project_id=project.id, name="f", field_type=FieldType.text)
    real_db.add(field); real_db.flush()
    real_db.add(AssetMetadata(asset_id=loose.id, field_id=field.id, value={"v": 1}))
    _share_link(real_db, owner, project=project)
    real_db.add(ActivityLog(project_id=project.id, action="created"))
    real_db.flush()

    counts = ct.PurgeCounts()
    ct._purge_project(real_db, project.id, counts)

    assert real_db.query(Project).filter_by(id=project.id).count() == 0
    assert real_db.query(Folder).filter_by(project_id=project.id).count() == 0
    assert real_db.query(Asset).filter_by(project_id=project.id).count() == 0
    assert real_db.query(ProjectBranding).filter_by(project_id=project.id).count() == 0
    assert real_db.query(WatermarkSettings).filter_by(project_id=project.id).count() == 0
    assert real_db.query(ProjectMember).filter_by(project_id=project.id).count() == 0
    assert real_db.query(Collection).filter_by(project_id=project.id).count() == 0
    assert real_db.query(CollectionShare).filter_by(collection_id=coll.id).count() == 0
    assert real_db.query(MetadataField).filter_by(project_id=project.id).count() == 0
    assert real_db.query(ShareLink).filter_by(project_id=project.id).count() == 0
    assert real_db.query(ActivityLog).filter_by(project_id=project.id).count() == 0
    assert "branding/logo.png" in deleted and "posters/p.webp" in deleted
    assert counts.projects == 1 and counts.assets == 2 and counts.folders == 1
