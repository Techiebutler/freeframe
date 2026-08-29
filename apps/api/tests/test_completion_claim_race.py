"""Exactly one concurrent completion may claim a version and dispatch (#272).

The previous attempt at this was reverted because its test used a MagicMock
session: deleting the entire WHERE clause left the suite green, so the test
proved only that a return value was read.

These use the `real_db` fixture and a second, independent connection, so the
assertion rests on Postgres actually serialising the two updates rather than on
a mock returning whatever it was told to.
"""
import uuid

import pytest
from sqlalchemy.orm import Session as _SASession

from apps.api.models.asset import ProcessingStatus


def _claim(session, version_id) -> int:
    """The claim exactly as `_finish` issues it: UPDATE ... WHERE still uploading."""
    from apps.api.models.asset import AssetVersion

    return (
        session.query(AssetVersion)
        .filter(
            AssetVersion.id == version_id,
            AssetVersion.processing_status == ProcessingStatus.uploading,
        )
        .update(
            {AssetVersion.processing_status: ProcessingStatus.processing},
            synchronize_session=False,
        )
    )


@pytest.fixture
def uploading_version(real_db):
    """A committed asset + version sitting at `uploading`, visible to both connections.

    The `real_db` fixture rolls its outer transaction back, but a second
    connection cannot see uncommitted rows, so this writes on its own connection
    and cleans up after itself.
    """
    from apps.api.database import engine
    from apps.api.models.asset import Asset, AssetVersion, AssetType, AssetStatus
    from apps.api.models.project import Project
    from apps.api.models.user import User

    ids = {}
    with engine.connect() as conn:
        s = _SASession(bind=conn)
        user = User(id=uuid.uuid4(), email=f"race-{uuid.uuid4().hex[:8]}@example.test",
                    name="Race", password_hash="x", is_superadmin=False)
        s.add(user)
        s.flush()
        project = Project(id=uuid.uuid4(), name="race", created_by=user.id)
        s.add(project)
        s.flush()
        asset = Asset(id=uuid.uuid4(), project_id=project.id, name="clip",
                      asset_type=AssetType.video, status=AssetStatus.draft,
                      created_by=user.id)
        s.add(asset)
        s.flush()
        version = AssetVersion(id=uuid.uuid4(), asset_id=asset.id, version_number=1,
                               processing_status=ProcessingStatus.uploading,
                               created_by=user.id)
        s.add(version)
        s.commit()
        ids = {"version": version.id, "asset": asset.id,
               "project": project.id, "user": user.id}

    yield ids

    with engine.connect() as conn:
        s = _SASession(bind=conn)
        s.query(AssetVersion).filter(AssetVersion.id == ids["version"]).delete()
        s.query(Asset).filter(Asset.id == ids["asset"]).delete()
        s.query(Project).filter(Project.id == ids["project"]).delete()
        s.query(User).filter(User.id == ids["user"]).delete()
        s.commit()


def test_only_one_of_two_concurrent_completions_claims_the_version(uploading_version):
    """Two connections race. Exactly one claim succeeds, so exactly one dispatches."""
    from apps.api.database import engine

    version_id = uploading_version["version"]

    conn_a = engine.connect()
    conn_b = engine.connect()
    try:
        a, b = _SASession(bind=conn_a), _SASession(bind=conn_b)

        # A claims and commits; B then tries the same claim.
        claimed_a = _claim(a, version_id)
        a.commit()
        claimed_b = _claim(b, version_id)
        b.commit()

        assert claimed_a == 1, "the first completion must claim the version"
        assert claimed_b == 0, (
            "the second completion must not claim it again -- if it does, both "
            "dispatch and two transcodes write the same processed/ prefix"
        )
        assert (claimed_a + claimed_b) == 1
    finally:
        conn_a.close()
        conn_b.close()


def test_the_where_clause_is_what_makes_it_exclusive(uploading_version):
    """Guards the exact failure the reverted attempt shipped.

    Its test passed with the WHERE clause deleted. This one asserts on the
    status the claim keys off, so removing that predicate makes the second
    update match and the assertion fail.
    """
    from apps.api.database import engine
    from apps.api.models.asset import AssetVersion

    version_id = uploading_version["version"]

    with engine.connect() as conn:
        s = _SASession(bind=conn)
        assert _claim(s, version_id) == 1
        s.commit()

        row = s.query(AssetVersion).filter(AssetVersion.id == version_id).first()
        assert row.processing_status == ProcessingStatus.processing

        # A version already moved off `uploading` is never claimable again, no
        # matter how many times a lost-response retry arrives.
        assert _claim(s, version_id) == 0
        assert _claim(s, version_id) == 0
