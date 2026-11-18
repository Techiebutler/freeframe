"""Who may delete someone else's comment (#492).

`delete_comment` lets the author or a project owner delete a comment, and the
review UI now offers owners that Delete. These pin the API side of that contract
so the menu and the endpoint cannot drift apart: an owner may delete another
member's comment and a guest's, and a reviewer gets 403 for either.
"""
import uuid

import pytest


def _seed(real_db):
    """A project with an owner, a reviewer, a commenter and a guest, and one
    comment each from the commenter and the guest."""
    from apps.api.models.user import User, GuestUser
    from apps.api.models.project import Project, ProjectMember, ProjectRole, ProjectType
    from apps.api.models.asset import Asset, AssetType, AssetVersion, ProcessingStatus
    from apps.api.models.comment import Comment

    def user(tag):
        u = User(email=f"cdm-{tag}-{uuid.uuid4()}@t.local", name=tag)
        real_db.add(u); real_db.flush()
        return u

    owner, reviewer, commenter = user("owner"), user("reviewer"), user("commenter")
    project = Project(name="t", project_type=ProjectType.personal, created_by=owner.id)
    real_db.add(project); real_db.flush()
    for member, role in ((owner, ProjectRole.owner), (reviewer, ProjectRole.reviewer),
                         (commenter, ProjectRole.reviewer)):
        real_db.add(ProjectMember(project_id=project.id, user_id=member.id, role=role))

    asset = Asset(project_id=project.id, name="t", asset_type=AssetType.video,
                  created_by=owner.id)
    real_db.add(asset); real_db.flush()
    version = AssetVersion(asset_id=asset.id, version_number=1,
                           processing_status=ProcessingStatus.ready, created_by=owner.id)
    real_db.add(version); real_db.flush()

    guest = GuestUser(email=f"cdm-guest-{uuid.uuid4()}@t.local", name="guest")
    real_db.add(guest); real_db.flush()

    by_member = Comment(asset_id=asset.id, version_id=version.id, author_id=commenter.id,
                        body="member note", visibility="public")
    by_guest = Comment(asset_id=asset.id, version_id=version.id, guest_author_id=guest.id,
                       body="guest note", visibility="public")
    real_db.add_all([by_member, by_guest]); real_db.flush()
    return owner, reviewer, by_member, by_guest


@pytest.mark.parametrize("target", ["member", "guest"])
def test_a_project_owner_can_delete_another_authors_comment(real_db, target):
    import apps.api.routers.comments as comments_module

    owner, _, by_member, by_guest = _seed(real_db)
    comment = by_member if target == "member" else by_guest

    comments_module.delete_comment(comment.id, db=real_db, current_user=owner)

    real_db.refresh(comment)
    assert comment.deleted_at is not None


@pytest.mark.parametrize("target", ["member", "guest"])
def test_a_reviewer_cannot_delete_another_authors_comment(real_db, target):
    from fastapi import HTTPException
    import apps.api.routers.comments as comments_module

    _, reviewer, by_member, by_guest = _seed(real_db)
    comment = by_member if target == "member" else by_guest

    with pytest.raises(HTTPException) as exc:
        comments_module.delete_comment(comment.id, db=real_db, current_user=reviewer)
    assert exc.value.status_code == 403

    real_db.refresh(comment)
    assert comment.deleted_at is None
