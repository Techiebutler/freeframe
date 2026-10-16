"""`GET /projects/{id}/share-links` returns each link's own title.

The list is three queries (asset links, folder links, project-root links)
joined with Query.union_all(). The project branch used to select
`ShareLink.title.label("target_name")`: the same column twice, once bare and
once labelled. SQLAlchemy's adaptation of the nested union then mapped the
`title` result column onto `target_name` too, so an asset or folder link came
back with its target's name as its title (a link titled "folder-new" on a
folder "F" listed as "F").
"""
import uuid

import pytest


@pytest.fixture
def seed(real_db):
    from apps.api.models.asset import Asset, AssetType
    from apps.api.models.folder import Folder
    from apps.api.models.project import Project, ProjectMember, ProjectRole, ProjectType
    from apps.api.models.share import ShareLink
    from apps.api.models.user import User

    owner = User(email=f"owner-{uuid.uuid4()}@t.local", name="owner")
    real_db.add(owner); real_db.flush()
    project = Project(name="Project P", project_type=ProjectType.personal, created_by=owner.id)
    real_db.add(project); real_db.flush()
    real_db.add(ProjectMember(project_id=project.id, user_id=owner.id, role=ProjectRole.owner))

    folder = Folder(project_id=project.id, name="F", created_by=owner.id)
    asset = Asset(project_id=project.id, name="clip.mp4", asset_type=AssetType.video,
                  created_by=owner.id)
    real_db.add_all([folder, asset]); real_db.flush()

    links = {
        "asset": ShareLink(token=f"a-{uuid.uuid4()}", created_by=owner.id,
                           asset_id=asset.id, title="asset-link-title"),
        "folder": ShareLink(token=f"f-{uuid.uuid4()}", created_by=owner.id,
                            folder_id=folder.id, title="folder-new"),
        "project": ShareLink(token=f"p-{uuid.uuid4()}", created_by=owner.id,
                             project_id=project.id, title="project-link-title"),
    }
    real_db.add_all(links.values()); real_db.flush()
    return {"owner": owner, "project": project, "links": links}


def _list(real_db, seed, search=None):
    from apps.api.routers.share import list_project_share_links
    return list_project_share_links(
        seed["project"].id, search=search, db=real_db, current_user=seed["owner"],
    )


def test_each_link_keeps_its_own_title_and_target_name(real_db, seed):
    items = {item.token: item for item in _list(real_db, seed)}
    links = seed["links"]
    assert len(items) == 3

    asset_item = items[links["asset"].token]
    assert asset_item.title == "asset-link-title"
    assert asset_item.target_name == "clip.mp4"
    assert asset_item.share_type == "asset"

    folder_item = items[links["folder"].token]
    assert folder_item.title == "folder-new"
    assert folder_item.target_name == "F"
    assert folder_item.share_type == "folder"

    project_item = items[links["project"].token]
    assert project_item.title == "project-link-title"
    # A project-root link has no separate target row; its own title stands in.
    assert project_item.target_name == "project-link-title"
    assert project_item.share_type == "folder"


def test_search_filters_on_the_links_title_not_the_target(real_db, seed):
    tokens = {item.token for item in _list(real_db, seed, search="folder-new")}
    assert tokens == {seed["links"]["folder"].token}
    # The folder is named "F"; searching its name must not match the link
    # (search is on ShareLink.title in every branch).
    assert {i.token for i in _list(real_db, seed, search="clip")} == set()
