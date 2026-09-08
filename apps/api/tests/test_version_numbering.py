"""A soft-deleted version must not block the number it used to hold.

`uq_asset_versions_asset_version` spans (asset_id, version_number) with no
regard for `deleted_at`, so numbering from the live versions alone hands back a
number the table is still holding. The INSERT then dies on the constraint, and
it does so permanently: that asset can never be given a version at that number
again.

Nothing unusual is needed to reach it. The stale-upload reaper soft-deletes a
version whose transfer stopped, so an asset that has had one upload reclaimed
refuses the next one -- a day later, with a 500 about a database constraint.
Discarding an upload does the same in seconds, which is how this was found: a
discarded v2, then "upload new version", then `duplicate key value violates
unique constraint`.
"""
import uuid

import pytest
from sqlalchemy.exc import IntegrityError

from apps.api.models.asset import ProcessingStatus


def _seed(db, statuses):
    """An asset with one version per status given, numbered in order."""
    from apps.api.models.user import User
    from apps.api.models.project import Project, ProjectType
    from apps.api.models.asset import Asset, AssetType, AssetVersion

    owner = User(email=f"vn-{uuid.uuid4()}@t.local", name="t")
    db.add(owner); db.flush()
    project = Project(name="t", project_type=ProjectType.personal, created_by=owner.id)
    db.add(project); db.flush()
    asset = Asset(project_id=project.id, name="t", asset_type=AssetType.video,
                  created_by=owner.id)
    db.add(asset); db.flush()
    versions = []
    for n, status in enumerate(statuses, start=1):
        v = AssetVersion(asset_id=asset.id, version_number=n,
                         processing_status=status, created_by=owner.id)
        db.add(v); db.flush()
        versions.append(v)
    return owner, asset, versions


def _next_number(db, asset_id) -> int:
    """The numbering the version-initiate endpoint does."""
    from apps.api.models.asset import AssetVersion
    last = db.query(AssetVersion).filter(
        AssetVersion.asset_id == asset_id,
    ).order_by(AssetVersion.version_number.desc()).first()
    return (last.version_number + 1) if last else 1


def test_the_number_after_a_discarded_version_is_free(real_db):
    from apps.api.models.asset import AssetVersion

    owner, asset, versions = _seed(
        real_db, [ProcessingStatus.ready, ProcessingStatus.uploading]
    )
    # v2 discarded, or reclaimed by the reaper: same thing to the constraint.
    versions[1].deleted_at = versions[1].created_at
    real_db.flush()

    number = _next_number(real_db, asset.id)

    assert number == 3, "v2 is spent, even though nothing live holds it"
    real_db.add(AssetVersion(asset_id=asset.id, version_number=number,
                             processing_status=ProcessingStatus.uploading,
                             created_by=owner.id))
    real_db.flush()  # must not raise


def test_numbering_from_live_versions_alone_hits_the_constraint(real_db):
    """The bug itself, so the fix above is not just a number changing."""
    from apps.api.models.asset import AssetVersion

    owner, asset, versions = _seed(
        real_db, [ProcessingStatus.ready, ProcessingStatus.uploading]
    )
    versions[1].deleted_at = versions[1].created_at
    real_db.flush()

    live_only = real_db.query(AssetVersion).filter(
        AssetVersion.asset_id == asset.id,
        AssetVersion.deleted_at.is_(None),
    ).order_by(AssetVersion.version_number.desc()).first()
    assert live_only.version_number + 1 == 2, "which is the number v2 still holds"

    # In a savepoint: the failed INSERT aborts its transaction, and the fixture
    # still has to roll the outer one back cleanly.
    with pytest.raises(IntegrityError):
        with real_db.begin_nested():
            real_db.add(AssetVersion(asset_id=asset.id, version_number=2,
                                     processing_status=ProcessingStatus.uploading,
                                     created_by=owner.id))
            real_db.flush()


def test_an_asset_with_no_versions_starts_at_one(real_db):
    _, asset, _ = _seed(real_db, [])

    assert _next_number(real_db, asset.id) == 1
