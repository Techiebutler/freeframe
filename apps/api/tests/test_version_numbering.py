"""Version numbers must not be handed out twice on one asset.

`uq_asset_versions_asset_version` spans `(asset_id, version_number)` and knows
nothing about `deleted_at`, so a soft-deleted version still owns its number. A
handler that numbers by counting only the *live* versions therefore hands back a
number the constraint is still holding, and the insert dies with an
`IntegrityError` — on every retry, permanently.

Reaching it needs no discard feature and no unusual use. `_reap_stale_uploads`
soft-deletes a version whose transfer stopped, so an asset that has had a single
upload reclaimed refuses the next one from then on.

There are two handlers that create versions and they are near-verbatim copies, so
every test here is parameterized over both. Fixing one and not the other is the
failure this file exists to prevent.
"""
import uuid

import pytest

import apps.api.routers.upload as upload_module
import apps.api.routers.assets as assets_module
from apps.api.models.asset import ProcessingStatus


def _seed(real_db, monkeypatch):
    """An owner, a project, and the monkeypatching both handlers need."""
    from apps.api.models.user import User
    from apps.api.models.project import Project, ProjectType

    owner = User(email=f"vn-{uuid.uuid4()}@t.local", name="t")
    real_db.add(owner)
    real_db.flush()
    project = Project(name="t", project_type=ProjectType.personal, created_by=owner.id)
    real_db.add(project)
    real_db.flush()

    for mod in (upload_module, assets_module):
        monkeypatch.setattr(mod, "create_multipart_upload", lambda k, m: "an-upload",
                            raising=False)
        monkeypatch.setattr(mod, "upload_guard_error", lambda db, n: None, raising=False)
        monkeypatch.setattr(mod, "require_project_role", lambda *a, **k: None, raising=False)

    return owner, project


def _call(path, real_db, owner, project, asset):
    """Create a version through whichever handler `path` names."""
    from apps.api.schemas.upload import InitiateUploadRequest

    body = InitiateUploadRequest(
        project_id=project.id,
        asset_id=asset.id if path == "initiate_upload" else None,
        asset_name="clip",
        original_filename="clip.mp4",
        mime_type="video/mp4",
        file_size_bytes=1024,
    )
    if path == "initiate_upload":
        return upload_module.initiate_upload(body, db=real_db, current_user=owner)
    return assets_module.initiate_new_version(
        asset.id, body, db=real_db, current_user=owner
    )


def _asset_with_versions(real_db, owner, project, numbers_and_deleted):
    """An asset carrying `(version_number, is_deleted)` rows."""
    from datetime import datetime, timezone
    from apps.api.models.asset import Asset, AssetType, AssetVersion

    asset = Asset(project_id=project.id, name="t", asset_type=AssetType.video,
                  created_by=owner.id)
    real_db.add(asset)
    real_db.flush()
    for number, is_deleted in numbers_and_deleted:
        version = AssetVersion(
            asset_id=asset.id,
            version_number=number,
            processing_status=ProcessingStatus.ready,
            created_by=owner.id,
            deleted_at=datetime.now(timezone.utc) if is_deleted else None,
        )
        real_db.add(version)
    real_db.flush()
    return asset


@pytest.mark.parametrize("path", ["initiate_upload", "initiate_new_version"])
def test_a_soft_deleted_version_does_not_give_its_number_back(
    real_db, monkeypatch, path
):
    """The regression: v2 soft-deleted by the reaper must not be reissued as v2."""
    from apps.api.models.asset import AssetVersion

    owner, project = _seed(real_db, monkeypatch)
    asset = _asset_with_versions(real_db, owner, project, [(1, False), (2, True)])

    result = _call(path, real_db, owner, project, asset)

    created = real_db.query(AssetVersion).filter(
        AssetVersion.id == result.version_id
    ).first()
    assert created.version_number == 3, (
        f"{path} reissued v{created.version_number}; the soft-deleted v2 still "
        "holds that number under uq_asset_versions_asset_version"
    )


@pytest.mark.parametrize("path", ["initiate_upload", "initiate_new_version"])
def test_numbering_still_follows_the_live_versions_when_none_are_deleted(
    real_db, monkeypatch, path
):
    """The ordinary case has to keep working: v1 and v2 live means the next is v3."""
    from apps.api.models.asset import AssetVersion

    owner, project = _seed(real_db, monkeypatch)
    asset = _asset_with_versions(real_db, owner, project, [(1, False), (2, False)])

    result = _call(path, real_db, owner, project, asset)

    created = real_db.query(AssetVersion).filter(
        AssetVersion.id == result.version_id
    ).first()
    assert created.version_number == 3


@pytest.mark.parametrize("path", ["initiate_upload", "initiate_new_version"])
def test_every_version_soft_deleted_still_numbers_past_them(
    real_db, monkeypatch, path
):
    """An asset whose only upload was reclaimed: the next one is v2, not v1."""
    from apps.api.models.asset import AssetVersion

    owner, project = _seed(real_db, monkeypatch)
    asset = _asset_with_versions(real_db, owner, project, [(1, True)])

    result = _call(path, real_db, owner, project, asset)

    created = real_db.query(AssetVersion).filter(
        AssetVersion.id == result.version_id
    ).first()
    assert created.version_number == 2
