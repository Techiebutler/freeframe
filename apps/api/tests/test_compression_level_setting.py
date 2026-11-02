"""The compression level is an instance setting, and only an admin may set it.

The transcoder half of this feature is a `TRANSCODER_CRF_OFFSET` environment
variable (see `test_transcoder_crf_offset.py`). The setting exists because an
environment variable is the wrong place for a judgement call about picture
quality: it needs a container rebuild, and the person who notices the banding
is the person reviewing, not the person with shell access.
"""
from unittest.mock import MagicMock

import pytest

import apps.api.routers.instance_settings as settings_module
from apps.api.models.instance_settings import InstanceSettings
from apps.api.schemas.instance_settings import InstanceSettingsUpdate
from apps.api.services import storage as storage_service
from packages.transcoder.base import COMPRESSION_LEVELS, DEFAULT_COMPRESSION_LEVEL

@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    """No storage scan, and no ambient offset deciding what these assert."""
    monkeypatch.setattr(storage_service, "instance_storage_used_bytes", lambda db: 0)
    monkeypatch.delenv("TRANSCODER_CRF_OFFSET", raising=False)


def _row(**kw):
    row = MagicMock(storage_limit_bytes=0, upload_part_size_bytes=0,
                    allow_original_downloads=False, compression_level=None)
    for k, v in kw.items():
        setattr(row, k, v)
    return row


def test_the_column_is_nullable_and_the_default_step_changes_nothing():
    # The migration and the upgrade promise in one place. A server default of 3
    # would write "balanced" into every existing row and silently override an
    # instance's TRANSCODER_CRF_OFFSET; NULL keeps "nobody has chosen" a state
    # the instance can be in. And the default step is the no-op, so an upgrade
    # changes what an instance encodes at only once someone moves the slider.
    col = InstanceSettings.__table__.columns["compression_level"]
    assert (col.nullable, col.server_default, col.default) == (True, None, None)
    assert COMPRESSION_LEVELS[DEFAULT_COMPRESSION_LEVEL] == 0


def test_only_a_superadmin_may_see_or_set_the_level(
    client, auth_headers, mock_db, test_user
):
    # A member legitimately reads this endpoint for the storage figures, so the
    # response is curated per role and a new field has to join the curation --
    # forgetting that is how an admin-only field leaks.
    test_user.is_superadmin = False
    mock_db.first.return_value = _row(compression_level=1)

    body = client.get("/instance/settings", headers=auth_headers).json()
    assert "storage_used_bytes" in body
    assert [k for k in body if k.startswith("compression")] == []

    r = client.put("/instance/settings", headers=auth_headers,
                   json={"compression_level": 1})
    assert r.status_code == 403


@pytest.mark.parametrize("level", sorted(COMPRESSION_LEVELS))
def test_an_admin_can_set_every_level_on_the_scale(
    client, auth_headers, mock_db, test_user, level
):
    test_user.is_superadmin = True
    row = _row()
    mock_db.first.return_value = row

    body = client.put("/instance/settings", headers=auth_headers,
                      json={"compression_level": level}).json()

    assert row.compression_level == level
    assert body["compression_level"] == level
    assert body["compression_crf_offset"] == COMPRESSION_LEVELS[level]


@pytest.mark.parametrize("level", [0, 6, -1])
def test_a_level_off_the_scale_is_refused(
    client, auth_headers, mock_db, test_user, level
):
    # The bounds come from the scale itself rather than being written out again,
    # so adding a sixth step cannot leave the API rejecting it silently.
    test_user.is_superadmin = True
    bounds = {type(m).__name__: m for m
              in InstanceSettingsUpdate.model_fields["compression_level"].metadata}
    assert bounds["Ge"].ge == min(COMPRESSION_LEVELS)
    assert bounds["Le"].le == max(COMPRESSION_LEVELS)

    r = client.put("/instance/settings", headers=auth_headers,
                   json={"compression_level": level})
    assert r.status_code == 422


@pytest.mark.parametrize("stored,env,offset,step", [
    (None, "-8", -8, 1),                      # no level: the environment decides
    (DEFAULT_COMPRESSION_LEVEL, "-8", 0, 3),  # a chosen level wins over it
    (None, "-5", -5, None),                   # an expert value no step names
])
def test_the_page_is_shown_the_offset_the_next_transcode_will_use(
    client, auth_headers, mock_db, test_user, monkeypatch, stored, env, offset, step
):
    # The slider must not show one thing while the encoder does another, so the
    # response carries the effective offset and the step it sits on. A null step
    # is the honest answer for an offset no step names, and the UI says so
    # rather than pointing at a step the instance is not on.
    test_user.is_superadmin = True
    monkeypatch.setenv("TRANSCODER_CRF_OFFSET", env)
    row = _row(compression_level=stored)
    mock_db.first.return_value = row

    body = client.get("/instance/settings", headers=auth_headers).json()

    assert body["compression_crf_offset"] == offset
    assert body.get("compression_level_effective") == step
    # One function behind it, which is what keeps the page and the encoder from
    # drifting apart: the worker applies the same precedence.
    assert settings_module.effective_crf_offset(row) == offset


def test_a_fresh_instance_has_no_row_and_reading_does_not_create_one(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    test_user.is_superadmin = True
    monkeypatch.setenv("TRANSCODER_CRF_OFFSET", "-4")
    mock_db.first.return_value = None

    body = client.get("/instance/settings", headers=auth_headers).json()

    assert body["compression_crf_offset"] == -4
    mock_db.add.assert_not_called()


def test_an_explicit_null_clears_the_level_and_an_omitted_key_does_not(
    client, auth_headers, mock_db, test_user, monkeypatch
):
    # Why presence of the key is read instead of the value. Null is a real
    # instruction -- follow TRANSCODER_CRF_OFFSET again -- and without it the
    # setting is a one-way door only psql can reopen. Meanwhile every other save
    # from this page sends its own key alone and must not clear the level on the
    # way past.
    test_user.is_superadmin = True
    monkeypatch.setenv("TRANSCODER_CRF_OFFSET", "-4")
    row = _row(compression_level=1)
    mock_db.first.return_value = row

    client.put("/instance/settings", headers=auth_headers,
               json={"storage_limit_bytes": 1024})
    assert row.compression_level == 1

    body = client.put("/instance/settings", headers=auth_headers,
                      json={"compression_level": None}).json()

    assert row.compression_level is None
    assert "compression_level" not in body
    assert body["compression_crf_offset"] == -4
    assert body["compression_level_effective"] == 2
