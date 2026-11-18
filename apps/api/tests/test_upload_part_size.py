"""Uploads are cut on a part size the instance chooses, not on one fixed constant.

Every upload used to go up in 10 MB parts. Completing a multipart upload costs
something per part, so a large file sat at "95%" while the storage backend read
back and assembled thousands of them, and 10,000 parts capped a file at ~97.6 GB.

Now an admin picks Automatic (the default) or a fixed size in Instance Settings.
Automatic keeps 10 MB parts for files up to ~5 GB and grows the part beyond that
to hold about 500 of them. A fixed size too small for a file is refused before
anything is uploaded. Completions slow enough to notice are logged with where
the time went.
"""
import logging
import types
import uuid
from unittest.mock import MagicMock

import pytest

import apps.api.routers.assets as assets_module
import apps.api.routers.upload as upload_module
from apps.api.models.asset import ProcessingStatus
from apps.api.models.instance_settings import InstanceSettings
from apps.api.schemas.upload import (
    AUTO_MAX_PART_SIZE_BYTES,
    CHUNK_SIZE_BYTES,
    MAX_PARTS,
    part_count_error,
    part_size_for,
)
from apps.api.services import storage as storage_service

MiB = 1024 * 1024
GB = 1000 ** 3


# ── choosing a size ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("file_size, part_size", [
    (1 * GB, 10 * MiB),        # what every upload used to get
    (5 * GB, 10 * MiB),        # still under 500 parts of 10 MB
    (20 * GB, 39 * MiB),       # grown, in whole MiB, to hold ~500
    (100 * GB, 191 * MiB),
    (1000 * GB, 256 * MiB),    # capped; the count grows instead
])
def test_automatic_sizing_holds_about_500_parts(file_size, part_size):
    assert part_size_for(file_size, 0) == part_size
    assert part_size % MiB == 0
    if part_size < AUTO_MAX_PART_SIZE_BYTES:
        assert -(-file_size // part_size) <= 500


def test_a_fixed_size_is_used_as_it_is():
    assert part_size_for(1 * GB, 64 * MiB) == 64 * MiB
    assert part_size_for(500 * GB, 5 * MiB) == 5 * MiB


def test_a_fixed_size_refuses_a_file_10000_parts_cannot_hold():
    fits = MAX_PARTS * 10 * MiB
    assert part_count_error(fits, 10 * MiB, fixed=True) is None

    message = part_count_error(fits + 1, 10 * MiB, fixed=True)
    assert message is not None
    assert "10 MB upload part size" in message
    assert "Instance Settings" in message


def test_automatic_sizing_refuses_only_beyond_the_structural_ceiling():
    ceiling = MAX_PARTS * AUTO_MAX_PART_SIZE_BYTES
    assert part_count_error(ceiling, part_size_for(ceiling, 0), fixed=False) is None
    message = part_count_error(ceiling + 1, part_size_for(ceiling + 1, 0), fixed=False)
    assert message is not None
    assert "Instance Settings" not in message


def test_choose_part_size_reads_the_setting(mock_db):
    mock_db.first.return_value = None
    assert storage_service.choose_part_size(mock_db, 20 * GB) == (39 * MiB, None)

    mock_db.first.return_value = MagicMock(upload_part_size_bytes=10 * MiB)
    size, error = storage_service.choose_part_size(mock_db, 200 * GB)
    assert size == 10 * MiB
    assert error is not None


# ── initiate ──────────────────────────────────────────────────────────────────

def _initiate(client, auth_headers, mock_db, monkeypatch, path, file_size, part_choice):
    """Run one of the two initiate endpoints with storage and permissions stubbed.

    Returns (response, recorded rows, multipart uploads created).
    """
    created = []
    for mod in (upload_module, assets_module):
        monkeypatch.setattr(mod, "upload_guard_error", lambda db, n: None)
        monkeypatch.setattr(mod, "choose_part_size", lambda db, n: part_choice)
        monkeypatch.setattr(mod, "require_project_role", lambda *a, **k: None)
        monkeypatch.setattr(mod, "create_multipart_upload",
                            lambda k, m: created.append(k) or "upload-1")
    monkeypatch.setattr(assets_module, "next_version_number", lambda db, a: 1)
    monkeypatch.setattr(upload_module, "next_version_number", lambda db, a: 1)

    recorded = []

    def _add(obj):
        if getattr(obj, "id", None) is None:
            obj.id = uuid.uuid4()
        recorded.append(obj)

    mock_db.add.side_effect = _add
    project_id = uuid.uuid4()
    body = {
        "project_id": str(project_id),
        "asset_name": "clip",
        "original_filename": "clip.mov",
        "mime_type": "video/quicktime",
        "file_size_bytes": file_size,
    }
    if path == "new_asset":
        mock_db.first.return_value = MagicMock()  # the project
        resp = client.post("/upload/initiate", json=body, headers=auth_headers)
    else:
        mock_db.first.return_value = MagicMock(project_id=project_id)  # the asset
        resp = client.post(f"/assets/{uuid.uuid4()}/versions", json=body, headers=auth_headers)
    return resp, recorded, created


@pytest.mark.parametrize("path", ["new_asset", "new_version"])
def test_initiate_pins_and_returns_the_chosen_part_size(
    client, auth_headers, mock_db, monkeypatch, path
):
    resp, recorded, _ = _initiate(client, auth_headers, mock_db, monkeypatch, path,
                                  20 * GB, (39 * MiB, None))

    assert resp.status_code == 200, resp.text
    assert resp.json()["chunk_size_bytes"] == 39 * MiB
    versions = [o for o in recorded if hasattr(o, "version_number")]
    assert versions and versions[0].chunk_size_bytes == 39 * MiB


@pytest.mark.parametrize("path", ["new_asset", "new_version"])
def test_initiate_refuses_a_file_the_fixed_size_cannot_hold_before_creating_anything(
    client, auth_headers, mock_db, monkeypatch, path
):
    resp, recorded, created = _initiate(
        client, auth_headers, mock_db, monkeypatch, path,
        200 * GB, (10 * MiB, "File is larger than the 97.7 GB this instance's ..."),
    )

    assert resp.status_code == 400
    assert "97.7 GB" in resp.json()["detail"]
    assert created == []
    assert not [o for o in recorded if hasattr(o, "version_number")]


def test_a_file_over_the_old_97_gb_ceiling_is_accepted_by_the_schema(
    client, auth_headers, mock_db, monkeypatch
):
    resp, _, _ = _initiate(client, auth_headers, mock_db, monkeypatch, "new_asset",
                           150 * GB, (part_size_for(150 * GB, 0), None))
    assert resp.status_code == 200, resp.text


# ── the setting ───────────────────────────────────────────────────────────────

def test_instance_settings_has_the_part_size_column():
    col = InstanceSettings.__table__.columns["upload_part_size_bytes"]
    assert col.server_default.arg == "0"  # automatic
    assert col.nullable is False


@pytest.mark.parametrize("value", [0, 5 * MiB, 64 * MiB, 512 * MiB])
def test_put_accepts_automatic_or_a_size_in_range(
    client, auth_headers, mock_db, test_user, monkeypatch, value
):
    test_user.is_superadmin = True
    row = MagicMock(storage_limit_bytes=0, upload_part_size_bytes=0)
    mock_db.first.return_value = row
    monkeypatch.setattr(storage_service, "instance_storage_used_bytes", lambda db: 0)

    r = client.put("/instance/settings", headers=auth_headers,
                   json={"upload_part_size_bytes": value})

    assert r.status_code == 200, r.text
    assert row.upload_part_size_bytes == value
    assert r.json()["upload_part_size_bytes"] == value


@pytest.mark.parametrize("value", [1, 4 * MiB, 512 * MiB + 1, -1])
def test_put_rejects_a_size_out_of_range(client, auth_headers, mock_db, test_user, value):
    test_user.is_superadmin = True
    r = client.put("/instance/settings", headers=auth_headers,
                   json={"upload_part_size_bytes": value})
    assert r.status_code == 422


def test_put_is_admin_only(client, auth_headers, mock_db, test_user):
    test_user.is_superadmin = False
    r = client.put("/instance/settings", headers=auth_headers,
                   json={"upload_part_size_bytes": 64 * MiB})
    assert r.status_code == 403


def test_get_shows_the_part_size_to_an_admin_only(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    mock_db.first.return_value = MagicMock(storage_limit_bytes=0, upload_part_size_bytes=64 * MiB)
    monkeypatch.setattr(storage_service, "instance_storage_used_bytes", lambda db: 0)

    test_user.is_superadmin = True
    assert client.get("/instance/settings", headers=auth_headers).json()[
        "upload_part_size_bytes"] == 64 * MiB

    test_user.is_superadmin = False
    assert "upload_part_size_bytes" not in client.get(
        "/instance/settings", headers=auth_headers).json()


def test_get_with_no_row_reports_automatic_to_an_admin(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    test_user.is_superadmin = True
    mock_db.first.return_value = None
    monkeypatch.setattr(storage_service, "instance_storage_used_bytes", lambda db: 0)

    assert client.get("/instance/settings", headers=auth_headers).json()[
        "upload_part_size_bytes"] == 0
    mock_db.add.assert_not_called()


# ── the completion log ────────────────────────────────────────────────────────

def _complete(client, auth_headers, mock_db, test_user, monkeypatch, clock):
    version = MagicMock()
    version.id = uuid.uuid4()
    version.asset_id = uuid.uuid4()
    version.created_by = test_user.id
    version.processing_status = ProcessingStatus.uploading
    version.chunk_size_bytes = 10 * MiB
    media_file = MagicMock()
    media_file.s3_key_raw = "raw/p/a/v/original.mov"
    media_file.file_size_bytes = 23 * MiB
    mock_db.first.side_effect = [version, media_file]

    listing = [{"PartNumber": 1, "ETag": '"a"', "Size": 10 * MiB},
               {"PartNumber": 2, "ETag": '"b"', "Size": 10 * MiB},
               {"PartNumber": 3, "ETag": '"c"', "Size": 3 * MiB}]
    monkeypatch.setattr(upload_module, "list_upload_parts", lambda k, u: listing)
    monkeypatch.setattr(upload_module, "complete_multipart_upload", lambda k, u, p: None)
    monkeypatch.setattr(upload_module, "head_object_size", lambda k: None)
    monkeypatch.setattr(upload_module, "_trigger_processing", lambda a, v: None)
    ticks = iter(clock)
    monkeypatch.setattr(upload_module, "time", types.SimpleNamespace(monotonic=lambda: next(ticks)))

    return client.post("/upload/complete", headers=auth_headers, json={
        "s3_key": media_file.s3_key_raw, "upload_id": "upload-1",
        "asset_id": str(version.asset_id), "version_id": str(version.id), "parts": [],
    }), version


def test_a_slow_completion_logs_where_the_time_went(
    client, auth_headers, mock_db, test_user, monkeypatch, caplog
):
    # started, listed, assembled, finished
    with caplog.at_level(logging.WARNING, logger=upload_module.logger.name):
        resp, version = _complete(client, auth_headers, mock_db, test_user, monkeypatch,
                                  [100.0, 101.5, 130.0, 130.5])

    assert resp.status_code == 200, resp.text
    line = next(r.getMessage() for r in caplog.records if "took" in r.getMessage())
    assert str(version.id) in line
    assert "took 30.5s (3 parts of 10 MB, 23 MB total)" in line
    assert "listing 1.5s, assembling 28.5s, finishing 0.5s" in line


def test_a_quick_completion_logs_nothing(
    client, auth_headers, mock_db, test_user, monkeypatch, caplog
):
    with caplog.at_level(logging.WARNING, logger=upload_module.logger.name):
        resp, _ = _complete(client, auth_headers, mock_db, test_user, monkeypatch,
                            [100.0, 100.2, 101.0, 101.1])

    assert resp.status_code == 200, resp.text
    assert not [r for r in caplog.records if "took" in r.getMessage()]
