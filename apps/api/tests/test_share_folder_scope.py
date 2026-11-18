"""`GET /share/{token}/assets?folder_id=` lists a folder only inside the link's scope.

A multi-item share is a project link with ShareLinkItem rows. Its `folder_id`
branch checked only that the folder sat in the link's project, so any folder of
the project could be listed (names, thumbnails, sizes, creators, subfolders)
although streaming an asset from it was already refused by
`validate_asset_in_share`. The listing now applies the same rule: a shared
folder item or a descendant of one.
"""
import uuid

import pytest


def _folder(real_db, project, owner, name, parent=None):
    from apps.api.models.folder import Folder
    f = Folder(project_id=project.id, name=name, created_by=owner.id,
               parent_id=parent.id if parent else None)
    real_db.add(f); real_db.flush()
    return f


def _asset(real_db, project, owner, name, folder=None):
    from apps.api.models.asset import Asset, AssetType
    a = Asset(project_id=project.id, name=name, asset_type=AssetType.video,
              created_by=owner.id, folder_id=folder.id if folder else None)
    real_db.add(a); real_db.flush()
    return a


@pytest.fixture
def seed(real_db):
    """Project P: shared/ (with sub/ and sub/deep/), sibling/ (not shared).
    Project Q: other/. One link of each kind."""
    from apps.api.models.user import User
    from apps.api.models.project import Project, ProjectType
    from apps.api.models.share import ShareLink, ShareLinkItem

    owner = User(email=f"owner-{uuid.uuid4()}@t.local", name="owner")
    real_db.add(owner); real_db.flush()
    p = Project(name="p", project_type=ProjectType.personal, created_by=owner.id)
    q = Project(name="q", project_type=ProjectType.personal, created_by=owner.id)
    real_db.add_all([p, q]); real_db.flush()

    shared = _folder(real_db, p, owner, "shared")
    sub = _folder(real_db, p, owner, "sub", parent=shared)
    deep = _folder(real_db, p, owner, "deep", parent=sub)
    sibling = _folder(real_db, p, owner, "sibling")
    sibling_child = _folder(real_db, p, owner, "sibling-child", parent=sibling)
    other = _folder(real_db, q, owner, "other")

    _asset(real_db, p, owner, "in-shared", shared)
    _asset(real_db, p, owner, "in-sub", sub)
    _asset(real_db, p, owner, "in-sibling", sibling)
    _asset(real_db, q, owner, "in-other", other)

    multi = ShareLink(token=f"multi-{uuid.uuid4()}", created_by=owner.id, project_id=p.id)
    folder_link = ShareLink(token=f"folder-{uuid.uuid4()}", created_by=owner.id, folder_id=shared.id)
    project_link = ShareLink(token=f"proj-{uuid.uuid4()}", created_by=owner.id, project_id=p.id)
    real_db.add_all([multi, folder_link, project_link]); real_db.flush()
    real_db.add(ShareLinkItem(share_link_id=multi.id, folder_id=shared.id))
    real_db.flush()

    return {
        "multi": multi, "folder_link": folder_link, "project_link": project_link,
        "shared": shared, "sub": sub, "deep": deep, "sibling": sibling,
        "sibling_child": sibling_child, "other": other,
    }


def _list(real_db, link, folder_id):
    from apps.api.routers.share import get_folder_share_assets
    return get_folder_share_assets(
        link.token, folder_id=folder_id, page=1, per_page=50,
        share_session=None, db=real_db, current_user=None,
    )


def _refused(real_db, link, folder_id):
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        _list(real_db, link, folder_id)
    assert exc.value.status_code == 403
    return exc.value.detail


# ── multi-item project link ───────────────────────────────────────────────────

def test_multi_share_lists_its_shared_folder(real_db, seed):
    res = _list(real_db, seed["multi"], seed["shared"].id)

    assert [a.name for a in res.assets] == ["in-shared"]
    assert [f.name for f in res.subfolders] == ["sub"]


def test_multi_share_lists_descendants_of_its_shared_folder(real_db, seed):
    assert [a.name for a in _list(real_db, seed["multi"], seed["sub"].id).assets] == ["in-sub"]
    assert _list(real_db, seed["multi"], seed["deep"].id).assets == []


def test_multi_share_refuses_an_unshared_folder_of_the_same_project(real_db, seed):
    assert _refused(real_db, seed["multi"], seed["sibling"].id) == "Folder is not in the shared items"
    assert _refused(real_db, seed["multi"], seed["sibling_child"].id) == "Folder is not in the shared items"


def test_multi_share_refuses_a_folder_of_another_project(real_db, seed):
    assert _refused(real_db, seed["multi"], seed["other"].id) == "Folder is not within the shared project"


def test_multi_share_with_only_assets_refuses_every_folder(real_db, seed):
    """An asset-only multi share has no folder items, so no folder is in scope."""
    from apps.api.models.asset import Asset
    from apps.api.models.share import ShareLinkItem
    real_db.query(ShareLinkItem).filter(ShareLinkItem.share_link_id == seed["multi"].id).delete()
    in_shared = real_db.query(Asset).filter(Asset.name == "in-shared",
                                            Asset.folder_id == seed["shared"].id).one()
    real_db.add(ShareLinkItem(share_link_id=seed["multi"].id, asset_id=in_shared.id))
    real_db.flush()

    _refused(real_db, seed["multi"], seed["shared"].id)


def test_multi_share_refuses_a_deleted_shared_folder(real_db, seed):
    from datetime import datetime, timezone
    seed["shared"].deleted_at = datetime.now(timezone.utc)
    real_db.flush()

    _refused(real_db, seed["multi"], seed["shared"].id)


# ── plain folder link ─────────────────────────────────────────────────────────

def test_folder_link_lists_its_subtree(real_db, seed):
    assert [a.name for a in _list(real_db, seed["folder_link"], seed["sub"].id).assets] == ["in-sub"]


def test_folder_link_refuses_a_folder_outside_its_subtree(real_db, seed):
    assert _refused(real_db, seed["folder_link"], seed["sibling"].id) == "Folder is not within the shared folder"
    assert _refused(real_db, seed["folder_link"], seed["other"].id) == "Folder is not within the shared folder"


# ── plain project link ────────────────────────────────────────────────────────

def test_project_link_without_items_lists_any_folder_of_its_project(real_db, seed):
    assert [a.name for a in _list(real_db, seed["project_link"], seed["sibling"].id).assets] == ["in-sibling"]
    assert [a.name for a in _list(real_db, seed["project_link"], seed["sub"].id).assets] == ["in-sub"]


def test_project_link_refuses_a_folder_of_another_project(real_db, seed):
    assert _refused(real_db, seed["project_link"], seed["other"].id) == "Folder is not within the shared project"
