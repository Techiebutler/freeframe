"""An interrupted upload must not hide the working version underneath it.

`latest` by version number and `the one to show` are different questions: a v2 that
is uploading or failed is the newest, and is also the one thing a viewer cannot use.
Answering with it made an approved v1 read as failed, and made it unplayable.
"""
import uuid
from datetime import datetime, timezone, timedelta

import pytest

from apps.api.models.asset import ProcessingStatus


def _seed(db, statuses):
    """An asset with one version per status given, numbered in order."""
    from apps.api.models.user import User
    from apps.api.models.project import Project, ProjectType
    from apps.api.models.asset import Asset, AssetType, AssetVersion, MediaFile, FileType

    owner = User(email=f"lv-{uuid.uuid4()}@t.local", name="t")
    db.add(owner); db.flush()
    project = Project(name="t", project_type=ProjectType.personal, created_by=owner.id)
    db.add(project); db.flush()
    asset = Asset(project_id=project.id, name="t", asset_type=AssetType.video,
                  created_by=owner.id)
    db.add(asset); db.flush()

    versions = []
    for n, status in enumerate(statuses, start=1):
        v = AssetVersion(asset_id=asset.id, version_number=n, processing_status=status,
                         created_by=owner.id)
        db.add(v); db.flush()
        db.add(MediaFile(version_id=v.id, file_type=FileType.video,
                         original_filename="f.mp4", mime_type="video/mp4",
                         file_size_bytes=1, s3_key_raw=f"raw/{v.id}",
                         s3_key_processed=f"processed/{v.id}"))
        versions.append(v)
    db.flush()
    return owner, project, asset, versions


# ------------------------------------------------------------- _display_version

@pytest.mark.parametrize("interrupted", [ProcessingStatus.uploading, ProcessingStatus.failed])
def test_an_interrupted_v2_does_not_hide_a_ready_v1(real_db, interrupted):
    from apps.api.routers.assets import _display_version

    _, _, asset, versions = _seed(real_db, [ProcessingStatus.ready, interrupted])

    assert _display_version(real_db, asset.id).id == versions[0].id


def test_the_newest_ready_version_wins(real_db):
    from apps.api.routers.assets import _display_version

    _, _, asset, versions = _seed(
        real_db, [ProcessingStatus.ready, ProcessingStatus.ready, ProcessingStatus.failed]
    )

    assert _display_version(real_db, asset.id).id == versions[1].id


def test_processing_still_counts_as_showable(real_db):
    """"Being worked on" is true and useful; it is only upload states that are not."""
    from apps.api.routers.assets import _display_version

    _, _, asset, versions = _seed(real_db, [ProcessingStatus.ready, ProcessingStatus.processing])

    assert _display_version(real_db, asset.id).id == versions[1].id


def test_a_brand_new_asset_still_reports_that_it_is_uploading(real_db):
    """The fallback matters: with nothing viewable, report the upload, not nothing."""
    from apps.api.routers.assets import _display_version

    _, _, asset, versions = _seed(real_db, [ProcessingStatus.uploading])

    picked = _display_version(real_db, asset.id)
    assert picked.id == versions[0].id
    assert picked.processing_status == ProcessingStatus.uploading


# ------------------------------------------------------------ _playable_version

def test_a_processing_v2_does_not_make_a_ready_v1_unplayable(real_db):
    """Stricter than display: only `ready` can be streamed, so `processing` must not shadow."""
    from apps.api.routers.assets import _playable_version

    _, _, asset, versions = _seed(real_db, [ProcessingStatus.ready, ProcessingStatus.processing])

    assert _playable_version(real_db, asset.id).id == versions[0].id


def test_playable_falls_back_so_the_not_ready_message_still_happens(real_db):
    from apps.api.routers.assets import _playable_version

    _, _, asset, versions = _seed(real_db, [ProcessingStatus.processing])

    picked = _playable_version(real_db, asset.id)
    assert picked.id == versions[0].id
    assert picked.processing_status != ProcessingStatus.ready


# ------------------------------------------------------------------ bulk listing

def test_the_bulk_listing_agrees_with_the_single_lookup(real_db):
    """The grid and the detail view must not disagree about which version is shown."""
    from apps.api.routers.assets import _build_asset_responses_bulk, _display_version

    _, _, a1, v1 = _seed(real_db, [ProcessingStatus.ready, ProcessingStatus.failed])
    _, _, a2, v2 = _seed(real_db, [ProcessingStatus.uploading])
    _, _, a3, v3 = _seed(real_db, [ProcessingStatus.ready, ProcessingStatus.ready])

    responses = {r.id: r for r in _build_asset_responses_bulk([a1, a2, a3], real_db)}

    for asset, expected in ((a1, v1[0]), (a2, v2[0]), (a3, v3[1])):
        assert responses[asset.id].latest_version.id == expected.id
        assert _display_version(real_db, asset.id).id == expected.id


# ------------------------------------------------------------------ ghost assets

def test_the_reaper_removes_an_asset_it_has_stripped_of_every_version(real_db, monkeypatch):
    """Otherwise a failed upload reappears a day later as an un-openable card.

    `list_assets` deliberately shows assets that have no versions yet, and an asset
    the reaper has stripped is indistinguishable from a just-created one.
    """
    from apps.api.tasks import cleanup_tasks as ct

    monkeypatch.setattr(ct, "list_stale_multipart_uploads", lambda cutoff: [])
    monkeypatch.setattr(ct, "delete_object", lambda k: None)
    monkeypatch.setattr(ct, "delete_prefix", lambda k: None)

    _, _, doomed, dv = _seed(real_db, [ProcessingStatus.failed])
    _, _, survivor, sv = _seed(real_db, [ProcessingStatus.ready, ProcessingStatus.failed])
    for v in dv + sv:
        v.created_at = datetime.now(timezone.utc) - timedelta(hours=48)
    real_db.flush()

    ct._reap_stale_uploads(real_db)

    # Its only version is gone, so the asset goes too.
    assert doomed.deleted_at is not None
    # This one still has a live, ready v1: the asset must survive.
    assert survivor.deleted_at is None
    assert sv[0].deleted_at is None
    assert sv[1].deleted_at is not None
