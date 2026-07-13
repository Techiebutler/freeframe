"""Export endpoint (#84): dispatch, fps precedence, errors."""
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from apps.api.models.asset import AssetType, ProcessingStatus


def _asset(asset_type=AssetType.video):
    a = MagicMock()
    a.id = uuid.uuid4()
    a.name = "Demo Asset"
    a.asset_type = asset_type
    a.deleted_at = None
    return a


def _version(n=2):
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


def _comment(body="Fix logo", tc=2.52):
    c = MagicMock()
    c.id = uuid.uuid4()
    c.parent_id = None
    c.author_id = None
    c.guest_author_id = None
    c.body = body
    c.timecode_start = tc
    c.timecode_end = None
    c.resolved = False
    c.created_at = datetime(2026, 7, 13, tzinfo=timezone.utc)
    return c


@patch("apps.api.routers.comments.require_asset_access")
def test_edl_export_happy_path(_, client, mock_db, auth_headers):
    asset, version = _asset(), _version()
    mock_db.first.side_effect = [asset, version, _media()]
    mock_db.order_by.return_value = mock_db
    mock_db.all.side_effect = [[_comment()]]

    r = client.get(f"/assets/{asset.id}/comments/export?format=edl&version_id={version.id}",
                   headers=auth_headers)

    assert r.status_code == 200
    assert r.headers["content-disposition"] == 'attachment; filename="Demo Asset_v2_comments.edl"'
    assert "TITLE: Demo Asset" in r.text
    assert "|M:Unknown: Fix logo" in r.text


@patch("apps.api.routers.comments.require_asset_access")
def test_fps_required_when_unknown(_, client, mock_db, auth_headers):
    asset, version = _asset(), _version()
    mock_db.first.side_effect = [asset, version, _media(fps=None)]

    r = client.get(f"/assets/{asset.id}/comments/export?format=edl&version_id={version.id}",
                   headers=auth_headers)

    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "fps_required"


@patch("apps.api.routers.comments.require_asset_access")
def test_fps_override_beats_missing_stored_fps(_, client, mock_db, auth_headers):
    asset, version = _asset(), _version()
    mock_db.first.side_effect = [asset, version, _media(fps=None)]
    mock_db.order_by.return_value = mock_db
    mock_db.all.side_effect = [[_comment()]]

    r = client.get(f"/assets/{asset.id}/comments/export?format=edl&version_id={version.id}&fps=25",
                   headers=auth_headers)
    assert r.status_code == 200


@patch("apps.api.routers.comments.require_asset_access")
def test_nle_rejected_for_audio_but_csv_allowed(_, client, mock_db, auth_headers):
    asset, version = _asset(AssetType.audio), _version()
    mock_db.first.side_effect = [asset, version]
    r = client.get(f"/assets/{asset.id}/comments/export?format=edl&version_id={version.id}",
                   headers=auth_headers)
    assert r.status_code == 422

    mock_db.first.side_effect = [asset, version, _media(fps=None, duration=None)]
    mock_db.order_by.return_value = mock_db
    mock_db.all.side_effect = [[_comment()]]
    r = client.get(f"/assets/{asset.id}/comments/export?format=csv&version_id={version.id}",
                   headers=auth_headers)
    assert r.status_code == 200
    assert r.text.lstrip("\ufeff").startswith("comment_id,")


@patch("apps.api.routers.comments.require_asset_access")
def test_unknown_format_422(_, client, mock_db, auth_headers):
    r = client.get(f"/assets/{uuid.uuid4()}/comments/export?format=avid", headers=auth_headers)
    assert r.status_code == 422


@patch("apps.api.routers.comments.require_asset_access")
def test_version_not_found_404(_, client, mock_db, auth_headers):
    asset = _asset()
    mock_db.first.side_effect = [asset, None]
    r = client.get(f"/assets/{asset.id}/comments/export?format=edl&version_id={uuid.uuid4()}",
                   headers=auth_headers)
    assert r.status_code == 404
