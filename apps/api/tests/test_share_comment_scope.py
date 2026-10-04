"""A guest comment belongs to the asset its share link resolved, and to nothing else.

`POST /share/{token}/comment` resolved the asset from the link and checked it
against the link's scope, then wrote `body.version_id` straight through whenever
one was supplied. The export selects a version's comments by `version_id`, so a
comment filed against the shared asset could carry another asset's version id
and be exported as part of that asset's thread.

The guest @mention loop also created Mention + Notification rows for any
registered email, with none of the `can_access_asset` filtering that
`_create_mentions` applies to signed-in comments.
"""
import uuid
from datetime import datetime, timezone

import pytest


def _user(real_db, prefix):
    from apps.api.models.user import User
    u = User(email=f"{prefix}-{uuid.uuid4()}@t.local", name=prefix)
    real_db.add(u); real_db.flush()
    return u


def _asset(real_db, project, owner, versions=1):
    from apps.api.models.asset import Asset, AssetType, AssetVersion, ProcessingStatus
    asset = Asset(project_id=project.id, name="t", asset_type=AssetType.video,
                  created_by=owner.id)
    real_db.add(asset); real_db.flush()
    made = []
    for n in range(1, versions + 1):
        v = AssetVersion(asset_id=asset.id, version_number=n,
                         processing_status=ProcessingStatus.ready, created_by=owner.id)
        real_db.add(v); real_db.flush()
        made.append(v)
    return asset, made


@pytest.fixture
def seed(real_db, monkeypatch):
    """Two projects owned by the same user: asset A (two versions) behind a
    comment-permission link, and asset B in a project the link does not reach."""
    from apps.api.models.project import Project, ProjectType
    from apps.api.models.share import ShareLink, SharePermission
    import apps.api.routers.comments as comments_module

    # The live-update publish is best-effort and irrelevant here; keep it off the broker.
    monkeypatch.setattr(comments_module.event_service, "publish_sync", lambda *a, **k: True)

    owner = _user(real_db, "owner")
    project_a = Project(name="a", project_type=ProjectType.personal, created_by=owner.id)
    project_b = Project(name="b", project_type=ProjectType.personal, created_by=owner.id)
    real_db.add_all([project_a, project_b]); real_db.flush()

    asset_a, versions_a = _asset(real_db, project_a, owner, versions=2)
    asset_b, versions_b = _asset(real_db, project_b, owner)

    link = ShareLink(token=f"tok-{uuid.uuid4()}", created_by=owner.id, asset_id=asset_a.id,
                     permission=SharePermission.comment)
    real_db.add(link); real_db.flush()

    return {
        "owner": owner, "project_a": project_a, "link": link,
        "asset_a": asset_a, "versions_a": versions_a,
        "asset_b": asset_b, "version_b": versions_b[0],
    }


def _post(real_db, link, **body):
    from apps.api.schemas.comment import GuestCommentCreate
    import apps.api.routers.comments as comments_module
    body.setdefault("body", "a guest note")
    return comments_module.guest_comment(
        link.token,
        GuestCommentCreate(guest_email="guest@t.local", guest_name="Guest", **body),
        share_session=None, db=real_db, current_user=None,
    )


def _comments_with_body(real_db, text):
    from apps.api.models.comment import Comment
    return real_db.query(Comment).filter(Comment.body == text).all()


# ── version_id ────────────────────────────────────────────────────────────────

def test_a_version_of_another_asset_is_refused_and_nothing_is_stored(real_db, seed):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        _post(real_db, seed["link"], body="foreign version", version_id=seed["version_b"].id)

    assert exc.value.status_code == 400
    assert exc.value.detail == "version_id does not belong to this asset"
    assert _comments_with_body(real_db, "foreign version") == []


def test_a_body_asset_id_does_not_widen_the_version_check(real_db, seed):
    """The web client always sends `asset_id` alongside `version_id`. Naming the
    other asset in the body must not make its version acceptable: the check is
    against the asset the link resolved."""
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        _post(real_db, seed["link"], body="body names B", asset_id=seed["asset_b"].id,
              version_id=seed["version_b"].id)

    assert exc.value.status_code == 400
    assert _comments_with_body(real_db, "body names B") == []


def test_an_older_version_of_the_shared_asset_is_kept(real_db, seed):
    """The guard must not narrow the ordinary case to the latest version."""
    v1, v2 = seed["versions_a"]

    result = _post(real_db, seed["link"], body="on v1", version_id=v1.id)

    [saved] = _comments_with_body(real_db, "on v1")
    assert result.id == saved.id
    assert saved.asset_id == seed["asset_a"].id
    assert saved.version_id == v1.id


def test_an_omitted_version_still_resolves_to_the_latest_ready_one(real_db, seed):
    v1, v2 = seed["versions_a"]

    _post(real_db, seed["link"], body="no version given")

    [saved] = _comments_with_body(real_db, "no version given")
    assert saved.version_id == v2.id


def test_a_deleted_version_of_the_shared_asset_is_refused(real_db, seed):
    from fastapi import HTTPException

    v1, _ = seed["versions_a"]
    v1.deleted_at = datetime.now(timezone.utc)
    real_db.flush()

    with pytest.raises(HTTPException) as exc:
        _post(real_db, seed["link"], body="on a deleted version", version_id=v1.id)

    assert exc.value.status_code == 400
    assert _comments_with_body(real_db, "on a deleted version") == []


# ── @mentions ─────────────────────────────────────────────────────────────────

def _mentions_and_notifications(real_db, user):
    from apps.api.models.activity import Mention, Notification
    return (
        real_db.query(Mention).filter(Mention.mentioned_user_id == user.id).count(),
        real_db.query(Notification).filter(Notification.user_id == user.id).count(),
    )


def test_a_mentioned_user_without_access_is_not_notified(real_db, seed):
    outsider = _user(real_db, "outsider")

    _post(real_db, seed["link"], body=f"hey @{outsider.email} look")

    assert _mentions_and_notifications(real_db, outsider) == (0, 0)


def test_a_mentioned_project_member_is_still_notified(real_db, seed):
    from apps.api.models.project import ProjectMember, ProjectRole

    member = _user(real_db, "member")
    real_db.add(ProjectMember(project_id=seed["project_a"].id, user_id=member.id,
                              role=ProjectRole.reviewer))
    real_db.flush()

    _post(real_db, seed["link"], body=f"hey @{member.email} look")

    assert _mentions_and_notifications(real_db, member) == (1, 1)


# ── export ────────────────────────────────────────────────────────────────────

def test_export_leaves_out_a_row_filed_under_another_asset(real_db, seed):
    """The guard above stops new rows; this covers a row an earlier build already
    committed with another asset's version id."""
    from apps.api.models.comment import Comment
    import apps.api.routers.comments as comments_module

    owner, asset_a, asset_b, version_b = (
        seed["owner"], seed["asset_a"], seed["asset_b"], seed["version_b"])
    real_db.add_all([
        Comment(asset_id=asset_b.id, version_id=version_b.id, author_id=owner.id,
                body="genuine b comment", visibility="public"),
        # Written directly, the way pre-fix code would have committed it.
        Comment(asset_id=asset_a.id, version_id=version_b.id, author_id=owner.id,
                body="filed under a", visibility="public"),
    ])
    real_db.flush()

    resp = comments_module.export_comments(
        asset_b.id, format="csv", version_id=None, fps=None, start_tc="01:00:00:00",
        include_resolved=True, db=real_db, current_user=owner,
    )

    csv = resp.body.decode("utf-8")
    assert "genuine b comment" in csv
    assert "filed under a" not in csv


# ── visibility ────────────────────────────────────────────────────────────────
#
# `GuestCommentCreate` had no visibility field, so an "internal" comment posted
# through a share link was stored as public and the share listing then returned
# it to every link holder. Internal now needs a caller who can open the asset,
# and is refused rather than downgraded otherwise.

def _post_as(real_db, link, user, **body):
    from apps.api.schemas.comment import GuestCommentCreate
    import apps.api.routers.comments as comments_module
    body.setdefault("body", "a signed-in note")
    return comments_module.guest_comment(
        link.token, GuestCommentCreate(**body),
        share_session=None, db=real_db, current_user=user,
    )


def _listed_to_a_signed_out_caller(real_db, link):
    import apps.api.routers.comments as comments_module
    listed = comments_module.list_share_comments(
        link.token, asset_id=None, version_id=None, latest_only=False,
        share_session=None, db=real_db, current_user=None,
    )
    return [c.body for c in listed]


def _member(real_db, project):
    from apps.api.models.project import ProjectMember, ProjectRole
    member = _user(real_db, "member")
    real_db.add(ProjectMember(project_id=project.id, user_id=member.id,
                              role=ProjectRole.reviewer))
    real_db.flush()
    return member


def test_an_internal_comment_from_a_project_member_stays_internal(real_db, seed):
    member = _member(real_db, seed["project_a"])

    _post_as(real_db, seed["link"], member, body="team only", visibility="internal")

    [saved] = _comments_with_body(real_db, "team only")
    assert saved.visibility == "internal"
    assert saved.author_id == member.id
    assert "team only" not in _listed_to_a_signed_out_caller(real_db, seed["link"])


def test_an_internal_comment_from_an_anonymous_guest_is_refused(real_db, seed):
    from fastapi import HTTPException
    from apps.api.models.user import GuestUser

    with pytest.raises(HTTPException) as exc:
        _post(real_db, seed["link"], body="guest internal", visibility="internal")

    assert exc.value.status_code == 403
    assert exc.value.detail == "Internal comments require access to the asset"
    assert _comments_with_body(real_db, "guest internal") == []
    # Refused before the guest identity is written, too.
    assert real_db.query(GuestUser).filter(GuestUser.email == "guest@t.local").count() == 0


def test_an_internal_comment_from_a_signed_in_user_without_access_is_refused(real_db, seed):
    """Holding the link and an account is not access to the asset."""
    from fastapi import HTTPException

    outsider = _user(real_db, "outsider")

    with pytest.raises(HTTPException) as exc:
        _post_as(real_db, seed["link"], outsider, body="outsider internal", visibility="internal")

    assert exc.value.status_code == 403
    assert _comments_with_body(real_db, "outsider internal") == []


def test_a_comment_with_no_visibility_is_still_public(real_db, seed):
    member = _member(real_db, seed["project_a"])

    _post_as(real_db, seed["link"], member, body="member default")
    _post(real_db, seed["link"], body="guest default")
    _post(real_db, seed["link"], body="guest explicit", visibility="public")

    for text in ("member default", "guest default", "guest explicit"):
        [saved] = _comments_with_body(real_db, text)
        assert saved.visibility == "public"
    listed = _listed_to_a_signed_out_caller(real_db, seed["link"])
    assert {"member default", "guest default", "guest explicit"} <= set(listed)


def test_an_unknown_visibility_is_rejected_by_the_schema():
    from pydantic import ValidationError
    from apps.api.schemas.comment import GuestCommentCreate

    with pytest.raises(ValidationError):
        GuestCommentCreate(body="x", visibility="secret")


def test_share_grid_comment_count_matches_visible_latest_version_tree(real_db, seed):
    from apps.api.models.comment import COMMENT_TREE_MAX_DEPTH, Comment
    import apps.api.routers.comments as comments_module
    from apps.api.routers.share import _latest_version_comment_count

    asset = seed["asset_a"]
    owner = seed["owner"]
    old_version, latest_version = seed["versions_a"]

    def add_comment(body, version_id, parent_id=None, visibility="public"):
        comment = Comment(
            asset_id=asset.id,
            version_id=version_id,
            parent_id=parent_id,
            author_id=owner.id,
            body=body,
            visibility=visibility,
        )
        real_db.add(comment)
        real_db.flush()
        return comment

    public_root = add_comment("public root", latest_version.id)
    add_comment("public reply", latest_version.id, parent_id=public_root.id)
    internal_reply = add_comment(
        "internal reply", latest_version.id, parent_id=public_root.id, visibility="internal"
    )
    add_comment("reply below internal reply", latest_version.id, parent_id=internal_reply.id)

    internal_root = add_comment("internal root", latest_version.id, visibility="internal")
    add_comment("reply below internal root", latest_version.id, parent_id=internal_root.id)
    add_comment("older-version root", old_version.id)

    deep_root = add_comment("deep root", latest_version.id)
    parent = deep_root
    for depth in range(COMMENT_TREE_MAX_DEPTH + 1):
        parent = add_comment(f"deep reply {depth}", latest_version.id, parent_id=parent.id)

    listed = comments_module.list_share_comments(
        seed["link"].token,
        asset_id=None,
        version_id=None,
        latest_only=True,
        share_session=None,
        db=real_db,
        current_user=None,
    )

    def tree_size(comments):
        return sum(1 + tree_size(comment.replies) for comment in comments)

    listed_count = tree_size(listed)
    assert listed_count == COMMENT_TREE_MAX_DEPTH + 3
    assert _latest_version_comment_count(real_db, asset.id) == listed_count
