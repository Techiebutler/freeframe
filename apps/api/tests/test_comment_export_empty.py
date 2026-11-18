"""An NLE export with nothing to place on a timeline must say so.

Producing a valid but empty marker file is the failure this guards against: the
download succeeds, the file opens, and the editing application reports nothing
to import — so the cause surfaces three applications away from where it is, and
looks like a broken export rather than an empty one.
"""
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.asset import AssetType, ProcessingStatus


def _asset(asset_type=AssetType.video):
    a = MagicMock()
    a.id = uuid.uuid4()
    a.name = "Demo Asset"
    a.asset_type = asset_type
    a.deleted_at = None
    return a


def _version(n=1):
    v = MagicMock()
    v.id = uuid.uuid4()
    v.version_number = n
    v.processing_status = ProcessingStatus.ready
    v.deleted_at = None
    return v


def _media(fps=25.0, duration=60.0):
    m = MagicMock()
    m.fps = fps
    m.duration_seconds = duration
    return m


def _comment(body="Fix the logo", tc=None, resolved=False):
    c = MagicMock()
    c.id = uuid.uuid4()
    c.parent_id = None
    c.author_id = None
    c.guest_author_id = None
    c.body = body
    c.timecode_start = tc
    c.timecode_end = None
    c.resolved = resolved
    c.created_at = datetime(2026, 9, 4, tzinfo=timezone.utc)
    return c


def _export(client, headers, asset, version, fmt="edl", extra=""):
    return client.get(
        f"/assets/{asset.id}/comments/export?format={fmt}&version_id={version.id}{extra}",
        headers=headers,
    )


@pytest.fixture
def rows(mock_db):
    """Wire the asset/version/media lookups; the test supplies the comments."""
    asset, version = _asset(), _version()
    mock_db.first.side_effect = [asset, version, _media()]
    mock_db.order_by.return_value = mock_db
    return asset, version


# ------------------------------------------------------------ the three reasons

@patch("apps.api.routers.comments.require_asset_access")
def test_comments_without_a_timecode_are_explained_not_exported(
    _, client, mock_db, auth_headers, rows
):
    """The case that prompted this: a reviewer typed the times into the text.

    A share link without a timecode control leaves every comment at
    timecode_start = NULL, so the version looks full of timed notes and exports
    to a header and nothing else.
    """
    asset, version = rows
    mock_db.all.side_effect = [[_comment("30:20 audio cuts out"), _comment("34:37 odd cut")]]

    r = _export(client, auth_headers, asset, version)

    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "no_timecoded_comments"
    # Names the cause and the way out, because the comments are visibly there.
    assert detail["message"].startswith("None of this version's comments are attached")
    assert "CSV" in detail["message"]


@patch("apps.api.routers.comments.require_asset_access")
def test_a_version_with_no_comments_says_that_instead(
    _, client, mock_db, auth_headers, rows
):
    asset, version = rows
    mock_db.all.side_effect = [[]]

    r = _export(client, auth_headers, asset, version)

    assert r.status_code == 422
    assert r.json()["detail"]["message"] == "This version has no comments to export."


@patch("apps.api.routers.comments.require_asset_access")
def test_excluding_resolved_comments_says_so_rather_than_reporting_none(
    _, client, mock_db, auth_headers, rows
):
    # The timecodes are there; the filter is what emptied the export. Telling
    # this apart from "nothing is timecoded" is the whole point of the message.
    asset, version = rows
    mock_db.all.side_effect = [[_comment(tc=12.0, resolved=True)]]

    r = _export(client, auth_headers, asset, version, extra="&include_resolved=false")

    assert r.status_code == 422
    assert "resolved" in r.json()["detail"]["message"]


# --------------------------------------------------------------- non-regression

@patch("apps.api.routers.comments.require_asset_access")
def test_one_timecoded_comment_is_still_exported(_, client, mock_db, auth_headers, rows):
    """The guard must refuse empty exports, not thin ones."""
    asset, version = rows
    mock_db.all.side_effect = [[_comment("Fix the logo", tc=2.52)]]

    r = _export(client, auth_headers, asset, version)

    assert r.status_code == 200
    assert "|M:Unknown: Fix the logo" in r.text


@patch("apps.api.routers.comments.require_asset_access")
def test_csv_still_exports_comments_that_have_no_timecode(
    _, client, mock_db, auth_headers, rows
):
    """CSV carries every comment, timecoded or not, and must not be blocked.

    It is the fallback the message above points at, so refusing it here would
    send the user in a circle.
    """
    asset, version = rows
    mock_db.all.side_effect = [[_comment("30:20 audio cuts out")]]

    r = _export(client, auth_headers, asset, version, fmt="csv")

    assert r.status_code == 200
    assert "30:20 audio cuts out" in r.text
