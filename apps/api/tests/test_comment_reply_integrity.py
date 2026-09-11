"""A reply must belong to the thread it claims, and must not lose what it carries.

Two defects, both of which answered 201 and then quietly did the wrong thing.

`create_comment` validated that `version_id` belonged to the asset and wrote
`parent_id` straight through with no check at all. Replies are read back by
`parent_id` alone, with no asset filter (`comments.py`, the `replies_raw` query),
so a comment created against one asset could be rendered inside a thread on
another, while `require_asset_access` had only ever been asked about the first.
The milder shape of the same bug is a reply to a soft-deleted parent: accepted,
and then returned by no read path ever again.

`POST /comments/{id}/replies` took a full `CommentCreate` and constructed the row
from `body.body` alone, so a timecoded or annotated reply was accepted and
stripped. The annotation is the part a reviewer cannot reproduce by retyping.
"""
import uuid

import pytest


def _seed(real_db, monkeypatch):
    """An owner, a project, and two assets each with a version."""
    from apps.api.models.user import User
    from apps.api.models.project import Project, ProjectType
    from apps.api.models.asset import Asset, AssetType, AssetVersion, ProcessingStatus
    import apps.api.routers.comments as comments_module

    owner = User(email=f"cri-{uuid.uuid4()}@t.local", name="t")
    real_db.add(owner); real_db.flush()
    project = Project(name="t", project_type=ProjectType.personal, created_by=owner.id)
    real_db.add(project); real_db.flush()

    made = []
    for _ in range(2):
        asset = Asset(project_id=project.id, name="t", asset_type=AssetType.video,
                      created_by=owner.id)
        real_db.add(asset); real_db.flush()
        version = AssetVersion(asset_id=asset.id, version_number=1,
                               processing_status=ProcessingStatus.ready, created_by=owner.id)
        real_db.add(version); real_db.flush()
        made.append((asset, version))

    monkeypatch.setattr(comments_module, "require_asset_access", lambda *a, **k: None)
    return owner, made


def _comment(real_db, asset, version, owner, **kw):
    from apps.api.models.comment import Comment
    c = Comment(asset_id=asset.id, version_id=version.id, author_id=owner.id,
                body="parent", visibility="public", **kw)
    real_db.add(c); real_db.flush()
    return c


def test_a_reply_cannot_be_parented_to_another_assets_comment(real_db, monkeypatch):
    """The one that matters: replies are read by parent_id with no asset filter,
    so this would have rendered inside the other asset's thread."""
    from fastapi import HTTPException
    from apps.api.schemas.comment import CommentCreate
    import apps.api.routers.comments as comments_module

    owner, [(asset_a, version_a), (asset_b, version_b)] = _seed(real_db, monkeypatch)
    on_b = _comment(real_db, asset_b, version_b, owner)

    with pytest.raises(HTTPException) as exc:
        comments_module.create_comment(
            asset_a.id,
            CommentCreate(version_id=version_a.id, body="injected", parent_id=on_b.id),
            db=real_db, current_user=owner,
        )
    assert exc.value.status_code == 400


def test_a_reply_to_a_deleted_parent_is_refused(real_db, monkeypatch):
    """Previously a 201 for a comment no read path would ever return."""
    from datetime import datetime, timezone
    from fastapi import HTTPException
    from apps.api.schemas.comment import CommentCreate
    import apps.api.routers.comments as comments_module

    owner, [(asset, version), _] = _seed(real_db, monkeypatch)
    parent = _comment(real_db, asset, version, owner)
    parent.deleted_at = datetime.now(timezone.utc)
    real_db.flush()

    with pytest.raises(HTTPException) as exc:
        comments_module.create_comment(
            asset.id,
            CommentCreate(version_id=version.id, body="orphan", parent_id=parent.id),
            db=real_db, current_user=owner,
        )
    assert exc.value.status_code == 400


def test_a_reply_to_a_live_parent_on_this_asset_still_works(real_db, monkeypatch):
    """The guard must not refuse the ordinary case."""
    from apps.api.schemas.comment import CommentCreate
    import apps.api.routers.comments as comments_module

    owner, [(asset, version), _] = _seed(real_db, monkeypatch)
    parent = _comment(real_db, asset, version, owner)

    result = comments_module.create_comment(
        asset.id,
        CommentCreate(version_id=version.id, body="a reply", parent_id=parent.id),
        db=real_db, current_user=owner,
    )
    assert result.parent_id == parent.id


def test_the_replies_endpoint_keeps_the_timecode_it_was_given(real_db, monkeypatch):
    """`/replies` built the row from `body.body` alone and dropped the rest."""
    from apps.api.models.comment import Comment
    from apps.api.schemas.comment import CommentCreate
    import apps.api.routers.comments as comments_module

    owner, [(asset, version), _] = _seed(real_db, monkeypatch)
    parent = _comment(real_db, asset, version, owner)

    result = comments_module.reply_to_comment(
        asset.id, parent.id,
        CommentCreate(version_id=version.id, body="at 12s", timecode_start=12.0,
                      timecode_end=15.0),
        db=real_db, current_user=owner,
    )

    saved = real_db.query(Comment).filter(Comment.id == result.id).first()
    assert saved.timecode_start == 12.0
    assert saved.timecode_end == 15.0


def test_the_replies_endpoint_keeps_the_annotation_it_was_given(real_db, monkeypatch):
    """The drawing is the part a reviewer cannot reproduce by retyping."""
    from apps.api.models.comment import Annotation
    from apps.api.schemas.comment import CommentCreate, AnnotationData
    import apps.api.routers.comments as comments_module

    owner, [(asset, version), _] = _seed(real_db, monkeypatch)
    parent = _comment(real_db, asset, version, owner)

    result = comments_module.reply_to_comment(
        asset.id, parent.id,
        CommentCreate(version_id=version.id, body="see the circle",
                      annotation=AnnotationData(drawing_data={"shapes": ["circle"]},
                                                frame_number=48)),
        db=real_db, current_user=owner,
    )

    saved = real_db.query(Annotation).filter(Annotation.comment_id == result.id).first()
    assert saved is not None, "the annotation was dropped"
    assert saved.frame_number == 48


def test_a_foreign_asset_reply_already_in_the_table_is_not_rendered(real_db, monkeypatch):
    """The guard above stops new rows. This is the other half: a row an earlier
    build already committed must not surface either.

    `_build_comment_response` walked replies by `parent_id` alone, so it
    rendered anything claiming this parent no matter which asset it was filed
    under. The list endpoint uses `_build_reply_tree`, which does filter on the
    asset, which is why this only ever showed up in the single-comment echo a
    write returns, and so was never noticed.
    """
    from apps.api.models.comment import Comment
    import apps.api.routers.comments as comments_module

    owner, [(asset_att, version_att), (asset_vic, version_vic)] = _seed(real_db, monkeypatch)
    victim = _comment(real_db, asset_vic, version_vic, owner)

    # Written directly, the way pre-fix code would have committed it.
    real_db.add(Comment(asset_id=asset_att.id, version_id=version_att.id,
                        author_id=owner.id, body="injected", visibility="public",
                        parent_id=victim.id))
    real_db.flush()

    resp = comments_module._build_comment_response(victim, real_db)
    assert [r.body for r in resp.replies] == []


def test_a_real_reply_is_still_rendered(real_db, monkeypatch):
    """The asset filter must not empty out ordinary threads."""
    from apps.api.models.comment import Comment
    import apps.api.routers.comments as comments_module

    owner, [(asset, version), _] = _seed(real_db, monkeypatch)
    parent = _comment(real_db, asset, version, owner)
    real_db.add(Comment(asset_id=asset.id, version_id=version.id, author_id=owner.id,
                        body="a genuine reply", visibility="public", parent_id=parent.id))
    real_db.flush()

    resp = comments_module._build_comment_response(parent, real_db)
    assert [r.body for r in resp.replies] == ["a genuine reply"]
