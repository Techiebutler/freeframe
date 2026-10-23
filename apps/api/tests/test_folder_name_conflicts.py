"""Folder name collisions answer 409, not 500 (#527).

`uq_folder_name_per_parent` is a partial unique index over live folders, so it
only exists in Postgres: these tests run the routes against a real session.
A trashed folder frees its name, and every route that can put a second live
folder of that name under the same parent (create, rename, move, bulk-move,
restore) must refuse it with a message instead of letting the index raise.
Root level has no such rule, because the index treats a NULL parent as distinct.
"""

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

import apps.api.routers.folders as folders_module
from apps.api.models.folder import Folder
from apps.api.models.project import Project, ProjectMember, ProjectRole, ProjectType
from apps.api.models.user import User
from apps.api.schemas.folder import BulkMoveRequest, FolderCreate, FolderUpdate


@pytest.fixture
def db():
    """A real session where each route commit is a SAVEPOINT the test can observe."""
    from apps.api.database import engine

    conn = engine.connect()
    trans = conn.begin()
    session = Session(bind=conn, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        trans.rollback()
        conn.close()


@pytest.fixture
def project(db):
    owner = User(email=f"folder-names-{uuid.uuid4()}@t.local", name="t")
    db.add(owner)
    db.flush()
    project = Project(
        name=f"folder-names-{uuid.uuid4()}",
        project_type=ProjectType.personal,
        created_by=owner.id,
    )
    db.add(project)
    db.flush()
    db.add(ProjectMember(project_id=project.id, user_id=owner.id, role=ProjectRole.editor))
    db.commit()
    return owner, project


def _create(db, owner, project, name, parent_id=None):
    resp = folders_module.create_folder(
        project.id, FolderCreate(name=name, parent_id=parent_id), db=db, current_user=owner,
    )
    return resp.id


def _live_named(db, project, parent_id, name):
    db.rollback()
    db.expire_all()
    return (
        db.query(Folder)
        .filter(
            Folder.project_id == project.id,
            Folder.parent_id == parent_id,
            Folder.name == name,
            Folder.deleted_at.is_(None),
        )
        .count()
    )


def _assert_conflict(exc_info, name):
    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == f"A folder named '{name}' already exists here"


def test_restoring_a_subfolder_whose_name_was_taken_answers_409(db, project):
    owner, project = project
    a = _create(db, owner, project, "A")
    old = _create(db, owner, project, "Dailies", a)
    folders_module.delete_folder(old, db=db, current_user=owner)
    _create(db, owner, project, "Dailies", a)

    with pytest.raises(HTTPException) as exc_info:
        folders_module.restore_folder(old, db=db, current_user=owner)

    _assert_conflict(exc_info, "Dailies")
    assert _live_named(db, project, a, "Dailies") == 1
    assert db.get(Folder, old).deleted_at is not None


def test_restoring_a_subfolder_whose_name_is_free_still_works(db, project):
    owner, project = project
    a = _create(db, owner, project, "A")
    old = _create(db, owner, project, "Dailies", a)
    folders_module.delete_folder(old, db=db, current_user=owner)

    assert folders_module.restore_folder(old, db=db, current_user=owner) == {"ok": True}

    assert _live_named(db, project, a, "Dailies") == 1
    assert db.get(Folder, old).deleted_at is None


def test_creating_a_duplicate_subfolder_answers_409(db, project):
    owner, project = project
    a = _create(db, owner, project, "A")
    _create(db, owner, project, "Dailies", a)

    with pytest.raises(HTTPException) as exc_info:
        _create(db, owner, project, "Dailies", a)

    _assert_conflict(exc_info, "Dailies")
    assert _live_named(db, project, a, "Dailies") == 1


def test_renaming_a_subfolder_to_a_taken_name_answers_409(db, project):
    owner, project = project
    a = _create(db, owner, project, "A")
    _create(db, owner, project, "Dailies", a)
    other = _create(db, owner, project, "Selects", a)

    with pytest.raises(HTTPException) as exc_info:
        folders_module.update_folder(
            other, FolderUpdate(name="Dailies"), db=db, current_user=owner,
        )

    _assert_conflict(exc_info, "Dailies")
    assert db.get(Folder, other).name == "Selects"


def test_renaming_a_subfolder_to_its_own_name_is_not_a_conflict(db, project):
    owner, project = project
    a = _create(db, owner, project, "A")
    dailies = _create(db, owner, project, "Dailies", a)

    resp = folders_module.update_folder(
        dailies, FolderUpdate(name="Dailies"), db=db, current_user=owner,
    )

    assert resp.name == "Dailies"


def test_moving_a_folder_next_to_a_same_named_folder_answers_409(db, project):
    owner, project = project
    a = _create(db, owner, project, "A")
    b = _create(db, owner, project, "B")
    _create(db, owner, project, "Dailies", a)
    moving = _create(db, owner, project, "Dailies", b)

    with pytest.raises(HTTPException) as exc_info:
        folders_module.update_folder(
            moving, FolderUpdate(parent_id=a), db=db, current_user=owner,
        )

    _assert_conflict(exc_info, "Dailies")
    assert db.get(Folder, moving).parent_id == b


def test_bulk_moving_a_folder_next_to_a_same_named_folder_answers_409(db, project):
    owner, project = project
    a = _create(db, owner, project, "A")
    b = _create(db, owner, project, "B")
    _create(db, owner, project, "Dailies", a)
    moving = _create(db, owner, project, "Dailies", b)

    with pytest.raises(HTTPException) as exc_info:
        folders_module.bulk_move(
            project.id,
            BulkMoveRequest(folder_ids=[moving], target_folder_id=a),
            db=db,
            current_user=owner,
        )

    _assert_conflict(exc_info, "Dailies")
    assert db.get(Folder, moving).parent_id == b


def test_bulk_moving_two_same_named_folders_into_one_parent_answers_409(db, project):
    owner, project = project
    a = _create(db, owner, project, "A")
    b = _create(db, owner, project, "B")
    target = _create(db, owner, project, "Target")
    first = _create(db, owner, project, "Dailies", a)
    second = _create(db, owner, project, "Dailies", b)

    with pytest.raises(HTTPException) as exc_info:
        folders_module.bulk_move(
            project.id,
            BulkMoveRequest(folder_ids=[first, second], target_folder_id=target),
            db=db,
            current_user=owner,
        )

    _assert_conflict(exc_info, "Dailies")
    assert _live_named(db, project, target, "Dailies") == 0


def test_root_level_duplicates_stay_allowed(db, project):
    owner, project = project
    _create(db, owner, project, "Dailies")
    _create(db, owner, project, "Dailies")
    old = _create(db, owner, project, "Selects")
    folders_module.delete_folder(old, db=db, current_user=owner)
    _create(db, owner, project, "Selects")

    assert folders_module.restore_folder(old, db=db, current_user=owner) == {"ok": True}

    assert _live_named(db, project, None, "Dailies") == 2
    assert _live_named(db, project, None, "Selects") == 2


def test_a_name_taken_after_the_check_still_answers_409(db, project, monkeypatch):
    """The index is the last word: a sibling created between the check and the
    write (a concurrent request) still comes back as 409, not 500."""
    owner, project = project
    a = _create(db, owner, project, "A")
    _create(db, owner, project, "Dailies", a)
    monkeypatch.setattr(folders_module, "_ensure_folder_name_free", lambda *a, **k: None)

    with pytest.raises(HTTPException) as exc_info:
        _create(db, owner, project, "Dailies", a)

    _assert_conflict(exc_info, "Dailies")
    assert _live_named(db, project, a, "Dailies") == 1
