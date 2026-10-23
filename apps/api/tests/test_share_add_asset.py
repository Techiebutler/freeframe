"""Adding an asset to an existing share link, and telling which links already show it (#470).

`POST /share/{token}/add-asset/{asset_id}` used to check only direct inclusion
(the link's own asset, or a ShareLinkItem for it). A whole-project link, or a
folder link above the asset, already shows it, yet the endpoint still wrote a
ShareLinkItem: that shrank a whole-project link to the one asset, and converted
a folder link to a multi-item link. The response did not say whether anything
was added either.

`GET /projects/{id}/share-links?asset_id=` marks each link with whether it
shows the asset directly, indirectly (through a folder or the whole project),
or not at all, so the asset's Share menu can list them apart.
"""
import uuid

import pytest


@pytest.fixture
def seed(real_db):
    from apps.api.models.asset import Asset, AssetType
    from apps.api.models.folder import Folder
    from apps.api.models.project import Project, ProjectMember, ProjectRole, ProjectType
    from apps.api.models.share import ShareLink, ShareLinkItem
    from apps.api.models.user import User

    owner = User(email=f"owner-{uuid.uuid4()}@t.local", name="owner")
    real_db.add(owner); real_db.flush()
    project = Project(name="Project P", project_type=ProjectType.personal, created_by=owner.id)
    real_db.add(project); real_db.flush()
    real_db.add(ProjectMember(project_id=project.id, user_id=owner.id, role=ProjectRole.owner))

    # F/G/trailer.mp4, plus a sibling folder H and a second root asset.
    f = Folder(project_id=project.id, name="F", created_by=owner.id)
    h = Folder(project_id=project.id, name="H", created_by=owner.id)
    real_db.add_all([f, h]); real_db.flush()
    g = Folder(project_id=project.id, name="G", parent_id=f.id, created_by=owner.id)
    real_db.add(g); real_db.flush()

    def asset(name, folder=None):
        a = Asset(project_id=project.id, name=name, asset_type=AssetType.video,
                  created_by=owner.id, folder_id=folder.id if folder else None)
        real_db.add(a); real_db.flush()
        return a

    trailer = asset("trailer.mp4", g)
    other = asset("other.mp4")
    root_clip = asset("root.mp4")

    def link(kind, **target):
        row = ShareLink(token=f"{kind}-{uuid.uuid4()}", created_by=owner.id, title=kind, **target)
        real_db.add(row); real_db.flush()
        return row

    links = {
        "single": link("single", asset_id=trailer.id),
        "single_other": link("single_other", asset_id=other.id),
        "whole": link("whole", project_id=project.id),
        "folder_above": link("folder_above", folder_id=f.id),
        "folder_sibling": link("folder_sibling", folder_id=h.id),
        "multi_with": link("multi_with", project_id=project.id),
        "multi_folder": link("multi_folder", project_id=project.id),
        "multi_without": link("multi_without", project_id=project.id),
    }
    real_db.add_all([
        ShareLinkItem(share_link_id=links["multi_with"].id, asset_id=trailer.id),
        ShareLinkItem(share_link_id=links["multi_with"].id, asset_id=other.id),
        ShareLinkItem(share_link_id=links["multi_folder"].id, folder_id=f.id),
        ShareLinkItem(share_link_id=links["multi_without"].id, asset_id=other.id),
    ])
    real_db.flush()
    return {
        "owner": owner, "project": project, "links": links,
        "trailer": trailer, "other": other, "root_clip": root_clip, "f": f, "h": h,
    }


def _add(real_db, seed, kind, asset_key="trailer"):
    from apps.api.routers.share import add_asset_to_share_link
    return add_asset_to_share_link(
        seed["links"][kind].token, seed[asset_key].id, db=real_db, current_user=seed["owner"],
    )


def _items(real_db, link):
    from apps.api.models.share import ShareLinkItem
    rows = real_db.query(ShareLinkItem).filter(ShareLinkItem.share_link_id == link.id).all()
    return {(r.asset_id, r.folder_id) for r in rows}


def _list(real_db, seed, asset_id=None):
    from apps.api.routers.share import list_project_share_links
    items = list_project_share_links(
        seed["project"].id, search=None, asset_id=asset_id, db=real_db, current_user=seed["owner"],
    )
    return {item.title: item.contains_asset for item in items}


def test_adding_to_a_whole_project_link_changes_nothing(real_db, seed):
    from apps.api.routers.share import get_folder_share_assets
    whole = seed["links"]["whole"]

    res = _add(real_db, seed, "whole")

    assert _items(real_db, whole) == set()
    # The link still shows the whole project root, not just the one asset.
    contents = get_folder_share_assets(
        whole.token, folder_id=None, page=1, per_page=50, share_session=None,
        db=real_db, current_user=seed["owner"],
    )
    assert {a.name for a in contents.assets} == {"other.mp4", "root.mp4"}
    assert {f.name for f in contents.subfolders} == {"F", "H"}
    assert res.get("added") is False


def test_adding_to_a_folder_link_above_the_asset_keeps_it_a_folder_link(real_db, seed):
    folder_link = seed["links"]["folder_above"]

    res = _add(real_db, seed, "folder_above")

    real_db.refresh(folder_link)
    assert folder_link.folder_id == seed["f"].id
    assert folder_link.project_id is None
    assert _items(real_db, folder_link) == set()
    assert res.get("added") is False


def test_adding_to_a_multi_link_through_one_of_its_folders_changes_nothing(real_db, seed):
    link = seed["links"]["multi_folder"]

    res = _add(real_db, seed, "multi_folder")

    assert _items(real_db, link) == {(None, seed["f"].id)}
    assert res.get("added") is False


@pytest.mark.parametrize("kind", ["single", "multi_with"])
def test_adding_to_a_link_that_already_lists_the_asset_reports_not_added(real_db, seed, kind):
    before = _items(real_db, seed["links"][kind])
    res = _add(real_db, seed, kind)
    assert _items(real_db, seed["links"][kind]) == before
    assert res.get("added") is False


def test_adding_to_a_single_asset_link_on_another_asset_still_converts_it(real_db, seed):
    link = seed["links"]["single_other"]

    res = _add(real_db, seed, "single_other")

    assert res.get("added") is True
    real_db.refresh(link)
    assert link.asset_id is None
    assert link.project_id == seed["project"].id
    assert _items(real_db, link) == {(seed["other"].id, None), (seed["trailer"].id, None)}


def test_adding_to_a_folder_link_that_does_not_reach_the_asset_still_adds_it(real_db, seed):
    link = seed["links"]["folder_sibling"]

    assert _add(real_db, seed, "folder_sibling").get("added") is True
    real_db.refresh(link)
    assert link.folder_id is None
    assert _items(real_db, link) == {(None, seed["h"].id), (seed["trailer"].id, None)}


def test_list_marks_how_each_link_shows_the_asset(real_db, seed):
    assert _list(real_db, seed, asset_id=seed["trailer"].id) == {
        "single": "direct",
        "multi_with": "direct",
        "whole": "indirect",
        "folder_above": "indirect",
        "multi_folder": "indirect",
        "single_other": None,
        "folder_sibling": None,
        "multi_without": None,
    }


def test_list_without_asset_id_leaves_contains_asset_unset(real_db, seed):
    marks = _list(real_db, seed)
    assert len(marks) == 8
    assert set(marks.values()) == {None}


def test_list_refuses_an_asset_from_another_project(real_db, seed):
    from fastapi import HTTPException
    from apps.api.models.asset import Asset, AssetType
    from apps.api.models.project import Project, ProjectType

    elsewhere = Project(name="Q", project_type=ProjectType.personal, created_by=seed["owner"].id)
    real_db.add(elsewhere); real_db.flush()
    stray = Asset(project_id=elsewhere.id, name="stray.mp4", asset_type=AssetType.video,
                  created_by=seed["owner"].id)
    real_db.add(stray); real_db.flush()

    with pytest.raises(HTTPException) as exc:
        _list(real_db, seed, asset_id=stray.id)
    assert exc.value.status_code == 404
