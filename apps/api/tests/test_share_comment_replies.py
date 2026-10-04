"""A reply posted through a share link must land in the thread it answers (#439).

`POST /share/{token}/comment` wrote `parent_id` straight through. An unknown id
hit the foreign key and answered 500. A parent on another asset, a deleted
parent, or an `internal` parent the guest can never see was accepted. And the
reply took the body's (or the latest) version instead of its parent's, so a
reply to a v1 note filed itself under v2.

Real database, not mocks: the guard is a query, and a mock would only ever
return what the test told it to.
"""
import uuid
from datetime import datetime, timezone

import pytest


def _seed(real_db, monkeypatch, permission="comment"):
    """An owner, a project, two assets (the first with v1 + v2), and a share link on the first."""
    from apps.api.models.user import User
    from apps.api.models.project import Project, ProjectType
    from apps.api.models.asset import Asset, AssetType, AssetVersion, ProcessingStatus
    from apps.api.models.share import ShareLink, SharePermission
    import apps.api.routers.comments as comments_module

    owner = User(email=f"scr-{uuid.uuid4()}@t.local", name="t")
    real_db.add(owner); real_db.flush()
    project = Project(name="t", project_type=ProjectType.personal, created_by=owner.id)
    real_db.add(project); real_db.flush()

    assets = []
    for n_versions in (2, 1):
        asset = Asset(project_id=project.id, name="t", asset_type=AssetType.video, created_by=owner.id)
        real_db.add(asset); real_db.flush()
        versions = []
        for n in range(1, n_versions + 1):
            v = AssetVersion(asset_id=asset.id, version_number=n,
                             processing_status=ProcessingStatus.ready, created_by=owner.id)
            real_db.add(v); real_db.flush()
            versions.append(v)
        assets.append((asset, versions))

    link = ShareLink(asset_id=assets[0][0].id, token=f"t-{uuid.uuid4()}", created_by=owner.id,
                     title="t", permission=SharePermission(permission))
    real_db.add(link); real_db.flush()

    # The link/session checks have their own tests; here the link is simply valid.
    monkeypatch.setattr(comments_module, "validate_share_link_with_session", lambda *a, **k: link)
    monkeypatch.setattr(comments_module, "validate_asset_in_share", lambda *a, **k: None)
    monkeypatch.setattr(comments_module.event_service, "publish_sync", lambda *a, **k: None)
    return owner, link, assets


def _comment(real_db, asset, version, owner, **kw):
    from apps.api.models.comment import Comment
    kw.setdefault("visibility", "public")
    author_id = kw.pop("author_id", owner.id)
    c = Comment(
        asset_id=asset.id,
        version_id=version.id,
        author_id=author_id,
        body="parent",
        **kw,
    )
    real_db.add(c); real_db.flush()
    return c


def _guest_reply(link, parent_id, current_user=None, **kw):
    import apps.api.routers.comments as comments_module
    from apps.api.schemas.comment import GuestCommentCreate
    body = GuestCommentCreate(body="a guest reply", parent_id=parent_id,
                              guest_name="Guest", guest_email=f"g-{uuid.uuid4()}@t.local", **kw)
    return lambda db: comments_module.guest_comment(link.token, body, share_session=None,
                                                    db=db, current_user=current_user)


def test_a_guest_reply_threads_under_its_parent_on_the_parents_version(real_db, monkeypatch):
    """The ordinary case, and the version rule: answering a v1 note while v2 is
    current files the reply under v1, as `reply_to_comment` does."""
    from apps.api.models.comment import Comment

    owner, link, [(asset, [v1, v2]), _] = _seed(real_db, monkeypatch)
    parent = _comment(real_db, asset, v1, owner)

    result = _guest_reply(link, parent.id, version_id=v2.id)(real_db)

    saved = real_db.query(Comment).filter(Comment.id == result.id).first()
    assert saved.parent_id == parent.id
    assert saved.version_id == v1.id


def test_an_unknown_parent_is_a_400_not_a_500(real_db, monkeypatch):
    from fastapi import HTTPException

    _, link, _ = _seed(real_db, monkeypatch)
    with pytest.raises(HTTPException) as exc:
        _guest_reply(link, uuid.uuid4())(real_db)
    assert exc.value.status_code == 400


def test_a_parent_on_another_asset_is_refused(real_db, monkeypatch):
    """Replies are read back by parent_id, so this would surface in a thread the
    link was never scoped to."""
    from fastapi import HTTPException

    owner, link, [_, (other, [other_v1])] = _seed(real_db, monkeypatch)
    elsewhere = _comment(real_db, other, other_v1, owner)
    with pytest.raises(HTTPException) as exc:
        _guest_reply(link, elsewhere.id)(real_db)
    assert exc.value.status_code == 400


def test_the_links_asset_wins_over_body_asset_id(real_db, monkeypatch):
    """A single-asset link resolves to its own asset; pointing `asset_id` at the
    parent's asset must not make a foreign parent acceptable."""
    from fastapi import HTTPException

    owner, link, [_, (other, [other_v1])] = _seed(real_db, monkeypatch)
    elsewhere = _comment(real_db, other, other_v1, owner)
    with pytest.raises(HTTPException) as exc:
        _guest_reply(link, elsewhere.id, asset_id=other.id)(real_db)
    assert exc.value.status_code == 400


def test_a_deleted_parent_is_refused(real_db, monkeypatch):
    from fastapi import HTTPException

    owner, link, [(asset, [v1, _]), _] = _seed(real_db, monkeypatch)
    parent = _comment(real_db, asset, v1, owner)
    parent.deleted_at = datetime.now(timezone.utc)
    real_db.flush()
    with pytest.raises(HTTPException) as exc:
        _guest_reply(link, parent.id)(real_db)
    assert exc.value.status_code == 400


def test_an_internal_parent_is_refused(real_db, monkeypatch):
    """A guest can never see an internal comment, so it can't be answered from a
    link either, and the answer would reveal that it exists."""
    from fastapi import HTTPException

    owner, link, [(asset, [v1, _]), _] = _seed(real_db, monkeypatch)
    parent = _comment(real_db, asset, v1, owner, visibility="internal")
    with pytest.raises(HTTPException) as exc:
        _guest_reply(link, parent.id)(real_db)
    assert exc.value.status_code == 400


def test_a_top_level_guest_comment_is_unchanged(real_db, monkeypatch):
    """No parent: the latest ready version, as before."""
    from apps.api.models.comment import Comment

    _, link, [(asset, [_, v2]), _] = _seed(real_db, monkeypatch)
    result = _guest_reply(link, None)(real_db)
    saved = real_db.query(Comment).filter(Comment.id == result.id).first()
    assert saved.parent_id is None
    assert saved.version_id == v2.id


def test_a_reply_with_another_assets_version_is_refused(real_db, monkeypatch):
    """The parent's version wins for a reply, but a supplied `version_id` is still
    checked first (#444). A reply to a comment on the shared asset that names a
    version of a different asset is a 400, and nothing is stored."""
    from fastapi import HTTPException
    from apps.api.models.comment import Comment

    owner, link, [(asset, [v1, _]), (_, [other_v1])] = _seed(real_db, monkeypatch)
    parent = _comment(real_db, asset, v1, owner)
    before = real_db.query(Comment).count()

    with pytest.raises(HTTPException) as exc:
        _guest_reply(link, parent.id, version_id=other_v1.id)(real_db)
    assert exc.value.status_code == 400
    assert exc.value.detail == "version_id does not belong to this asset"
    assert real_db.query(Comment).count() == before


def test_a_guest_reply_notifies_the_parent_author(real_db, monkeypatch):
    from apps.api.models.activity import Notification, NotificationType

    owner, link, [(asset, [v1, _]), _] = _seed(real_db, monkeypatch)
    parent = _comment(real_db, asset, v1, owner)

    result = _guest_reply(link, parent.id)(real_db)

    notification = real_db.query(Notification).filter(
        Notification.comment_id == result.id,
    ).one()
    assert notification.user_id == owner.id
    assert notification.type == NotificationType.comment
    assert notification.asset_id == asset.id


def test_a_member_replying_to_their_own_parent_does_not_notify_them(real_db, monkeypatch):
    from apps.api.models.activity import Notification

    owner, link, [(asset, [v1, _]), _] = _seed(real_db, monkeypatch)
    parent = _comment(real_db, asset, v1, owner)

    result = _guest_reply(link, parent.id, current_user=owner)(real_db)

    assert real_db.query(Notification).filter(
        Notification.comment_id == result.id,
    ).count() == 0


def test_replying_to_a_guest_comment_does_not_create_a_notification(real_db, monkeypatch):
    from apps.api.models.activity import Notification
    from apps.api.models.user import GuestUser

    owner, link, [(asset, [v1, _]), _] = _seed(real_db, monkeypatch)
    guest = GuestUser(email=f"parent-{uuid.uuid4()}@t.local", name="Guest")
    real_db.add(guest)
    real_db.flush()
    parent = _comment(
        real_db, asset, v1, owner, author_id=None, guest_author_id=guest.id,
    )

    result = _guest_reply(link, parent.id)(real_db)

    assert real_db.query(Notification).filter(
        Notification.comment_id == result.id,
    ).count() == 0


def _project_member(real_db, project_id):
    from apps.api.models.project import ProjectMember, ProjectRole
    from apps.api.models.user import User

    member = User(email="access-" + str(uuid.uuid4()) + "@t.local", name="Former member")
    real_db.add(member)
    real_db.flush()
    membership = ProjectMember(project_id=project_id, user_id=member.id, role=ProjectRole.editor)
    real_db.add(membership)
    real_db.flush()
    return member, membership


def test_a_member_reply_does_not_notify_a_parent_author_without_asset_access(real_db, monkeypatch):
    from apps.api.models.activity import Notification
    from apps.api.schemas.comment import CommentCreate
    from apps.api.services.permissions import can_access_asset
    import apps.api.routers.comments as comments_module

    owner, _, assets = _seed(real_db, monkeypatch)
    asset, versions = assets[0]
    former_member, membership = _project_member(real_db, asset.project_id)
    parent = _comment(real_db, asset, versions[0], owner, author_id=former_member.id)
    assert can_access_asset(real_db, asset, former_member)
    membership.deleted_at = datetime.now(timezone.utc)
    real_db.flush()
    assert not can_access_asset(real_db, asset, former_member)

    reply = comments_module.reply_to_comment(
        asset.id, parent.id,
        CommentCreate(version_id=versions[0].id, body="private reply"),
        db=real_db, current_user=owner,
    )

    assert real_db.query(Notification).filter(Notification.comment_id == reply.id).count() == 0


def test_a_guest_reply_does_not_notify_a_parent_author_without_asset_access(real_db, monkeypatch):
    from apps.api.models.activity import Notification
    from apps.api.services.permissions import can_access_asset

    owner, link, assets = _seed(real_db, monkeypatch)
    asset, versions = assets[0]
    former_member, membership = _project_member(real_db, asset.project_id)
    parent = _comment(real_db, asset, versions[0], owner, author_id=former_member.id)
    assert can_access_asset(real_db, asset, former_member)
    membership.deleted_at = datetime.now(timezone.utc)
    real_db.flush()
    assert not can_access_asset(real_db, asset, former_member)

    reply = _guest_reply(link, parent.id)(real_db)

    assert real_db.query(Notification).filter(Notification.comment_id == reply.id).count() == 0


def test_a_member_reply_still_notifies_a_parent_author_with_asset_access(real_db, monkeypatch):
    from apps.api.models.activity import Notification
    from apps.api.schemas.comment import CommentCreate
    from apps.api.services.permissions import can_access_asset
    import apps.api.routers.comments as comments_module

    owner, _, assets = _seed(real_db, monkeypatch)
    asset, versions = assets[0]
    member, _ = _project_member(real_db, asset.project_id)
    parent = _comment(real_db, asset, versions[0], owner)
    assert can_access_asset(real_db, asset, owner)

    reply = comments_module.reply_to_comment(
        asset.id, parent.id,
        CommentCreate(version_id=versions[0].id, body="visible reply"),
        db=real_db, current_user=member,
    )

    notification = real_db.query(Notification).filter(Notification.comment_id == reply.id).one()
    assert notification.user_id == owner.id
