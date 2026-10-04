"""Export endpoint (#84): dispatch, fps precedence, errors."""
import json
import subprocess
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
    assert r.headers["content-disposition"] == (
        'attachment; filename="Demo Asset_v2_comments.edl"; '
        "filename*=UTF-8''Demo%20Asset_v2_comments.edl"
    )
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


@patch("apps.api.routers.comments.require_asset_access")
def test_cjk_asset_name_export_does_not_crash(_, client, mock_db, auth_headers):
    """Non-ASCII asset names must not 500 (Content-Disposition is latin-1 only);
    the ASCII fallback filename is underscored, and the RFC 5987 filename*
    part carries the real UTF-8 name for browsers that support it."""
    asset, version = _asset(), _version()
    asset.name = "デモ動画 v2"
    mock_db.first.side_effect = [asset, version, _media()]
    mock_db.order_by.return_value = mock_db
    mock_db.all.side_effect = [[_comment()]]

    r = client.get(f"/assets/{asset.id}/comments/export?format=edl&version_id={version.id}",
                   headers=auth_headers)

    assert r.status_code == 200
    disposition = r.headers["content-disposition"]
    assert 'filename="____ v2_v2_comments.edl"' in disposition
    assert "filename*=UTF-8''" in disposition
    assert disposition.isascii()


def test_edl_export_uses_source_embedded_start_timecode(client, mock_db, auth_headers):
    asset, version = _asset(), _version()
    media = _media()
    media.s3_key_raw = "original/demo.mov"
    mock_db.first.side_effect = [asset, version, media]
    mock_db.order_by.return_value = mock_db
    mock_db.all.side_effect = [[_comment()]]

    probe_result = subprocess.CompletedProcess(
        ["ffprobe"],
        0,
        json.dumps({
            "streams": [{
                "codec_type": "video",
                "tags": {"timecode": "00:59:55:00"},
            }],
            "format": {"tags": {"timecode": "00:20:00:00"}},
        }),
        "",
    )
    with (
        patch("apps.api.routers.comments.require_asset_access"),
        patch(
            "apps.api.routers.comments.s3_service.generate_internal_presigned_get_url",
            return_value="https://storage.example/original.mov",
        ) as presign,
        patch("subprocess.run", return_value=probe_result) as ffprobe,
    ):
        response = client.get(
            f"/assets/{asset.id}/comments/export?format=edl&version_id={version.id}",
            headers=auth_headers,
        )

    assert response.status_code == 200
    assert "00:59:57:13" in response.text
    presign.assert_called_once_with("original/demo.mov", expires_in=300)
    command = ffprobe.call_args.args[0]
    assert command[0] == "ffprobe"
    assert command[-1] == "https://storage.example/original.mov"


def test_probe_uses_format_tag_after_invalid_video_tag():
    from apps.api.routers.comments import _probe_source_timecode

    media = MagicMock(id=uuid.uuid4(), s3_key_raw="original/demo.mov")
    probe_result = subprocess.CompletedProcess(
        ["ffprobe"],
        0,
        json.dumps({
            "streams": [
                {"codec_type": "video", "tags": {"timecode": "99:00:00:00"}},
                {"codec_type": "data", "tags": {"timecode": "00:02:00:00"}},
            ],
            "format": {"tags": {"timecode": "00:40:00:00"}},
        }),
        "",
    )
    with (
        patch(
            "apps.api.routers.comments.s3_service.generate_internal_presigned_get_url",
            return_value="https://storage.example/original.mov",
        ),
        patch("subprocess.run", return_value=probe_result),
    ):
        timecode = _probe_source_timecode(media, MagicMock(timebase=25))

    assert timecode == "00:40:00:00"


@pytest.mark.parametrize(
    ("source_tc", "expected_mode", "expected_record"),
    [
        ("00:59:55:00", "NON-DROP FRAME", "00:59:57:16"),
        ("00:59:55;00", "DROP FRAME", "00:59:57;16"),
    ],
)
def test_edl_export_preserves_source_drop_frame_mode(
    client, mock_db, auth_headers, source_tc, expected_mode, expected_record
):
    asset, version = _asset(), _version()
    media = _media(fps=29.97)
    media.s3_key_raw = "original/demo.mov"
    mock_db.first.side_effect = [asset, version, media]
    mock_db.order_by.return_value = mock_db
    mock_db.all.side_effect = [[_comment()]]

    probe_result = subprocess.CompletedProcess(
        ["ffprobe"],
        0,
        json.dumps({
            "streams": [{
                "codec_type": "video",
                "tags": {"timecode": source_tc},
            }],
            "format": {"tags": {}},
        }),
        "",
    )
    with (
        patch("apps.api.routers.comments.require_asset_access"),
        patch(
            "apps.api.routers.comments.s3_service.generate_internal_presigned_get_url",
            return_value="http://minio:9000/original/demo.mov",
        ),
        patch("subprocess.run", return_value=probe_result),
    ):
        response = client.get(
            f"/assets/{asset.id}/comments/export?format=edl&version_id={version.id}",
            headers=auth_headers,
        )

    assert response.status_code == 200
    assert f"FCM: {expected_mode}" in response.text
    assert expected_record in response.text


def test_edl_export_explicit_start_timecode_skips_source_probe(client, mock_db, auth_headers):
    asset, version = _asset(), _version()
    media = _media()
    media.s3_key_raw = "original/demo.mov"
    mock_db.first.side_effect = [asset, version, media]
    mock_db.order_by.return_value = mock_db
    mock_db.all.side_effect = [[_comment()]]

    with (
        patch("apps.api.routers.comments.require_asset_access"),
        patch("apps.api.routers.comments.s3_service.generate_internal_presigned_get_url") as presign,
        patch("subprocess.run") as ffprobe,
    ):
        response = client.get(
            f"/assets/{asset.id}/comments/export?format=edl&version_id={version.id}"
            "&start_tc=00:30:00:00",
            headers=auth_headers,
        )

    assert response.status_code == 200
    assert "00:30:02:13" in response.text
    presign.assert_not_called()
    ffprobe.assert_not_called()


def test_edl_export_falls_back_when_source_has_no_timecode(client, mock_db, auth_headers):
    asset, version = _asset(), _version()
    media = _media()
    media.s3_key_raw = "original/demo.mov"
    mock_db.first.side_effect = [asset, version, media]
    mock_db.order_by.return_value = mock_db
    mock_db.all.side_effect = [[_comment()]]

    probe_result = subprocess.CompletedProcess(
        ["ffprobe"],
        0,
        json.dumps({
            "streams": [{"codec_type": "video", "tags": {}}],
            "format": {"tags": {}},
        }),
        "",
    )
    with (
        patch("apps.api.routers.comments.require_asset_access"),
        patch(
            "apps.api.routers.comments.s3_service.generate_internal_presigned_get_url",
            return_value="https://storage.example/original.mov",
        ),
        patch("subprocess.run", return_value=probe_result),
    ):
        response = client.get(
            f"/assets/{asset.id}/comments/export?format=edl&version_id={version.id}",
            headers=auth_headers,
        )

    assert response.status_code == 200
    assert "01:00:02:13" in response.text


@patch("apps.api.routers.comments.require_asset_access")
def test_start_tc_out_of_range_422(_, client, mock_db, auth_headers):
    """start_tc=99:99:99:99 satisfies the HH:MM:SS:FF regex but every field
    is out of range for any supported frame rate."""
    asset, version = _asset(), _version()
    mock_db.first.side_effect = [asset, version, _media()]

    r = client.get(
        f"/assets/{asset.id}/comments/export?format=edl&version_id={version.id}"
        "&start_tc=99:99:99:99",
        headers=auth_headers,
    )

    assert r.status_code == 422
    assert "out of range" in r.json()["detail"]


@patch("apps.api.routers.comments.require_asset_access")
def test_cors_exposes_content_disposition(_, client, mock_db, auth_headers):
    """Cross-origin JS can only read the export filename if CORS exposes the header.
    Verify via a live CORS preflight/response with Origin header."""
    asset, version = _asset(), _version()
    mock_db.first.side_effect = [asset, version, _media()]
    mock_db.order_by.return_value = mock_db
    mock_db.all.side_effect = [[_comment()]]

    # Send request with Origin header (simulates cross-origin fetch)
    r = client.get(
        f"/assets/{asset.id}/comments/export?format=edl&version_id={version.id}",
        headers={**auth_headers, "Origin": "http://localhost:3000"},
    )

    assert r.status_code == 200
    # Content-Disposition is set by the endpoint
    assert "content-disposition" in r.headers
    # CORS expose-headers makes it readable by cross-origin JS
    assert "access-control-expose-headers" in r.headers
    assert "Content-Disposition" in r.headers["access-control-expose-headers"]


@pytest.mark.parametrize("start_mode", ["fallback", "explicit"])
def test_edl_export_keeps_default_drop_frame_mode_for_fallback_and_explicit_tc(
    client, mock_db, auth_headers, start_mode
):
    asset, version = _asset(), _version()
    media = _media(fps=29.97)
    media.s3_key_raw = "original/demo.mov"
    mock_db.first.side_effect = [asset, version, media]
    mock_db.order_by.return_value = mock_db
    mock_db.all.side_effect = [[_comment()]]

    probe_result = subprocess.CompletedProcess(
        ["ffprobe"],
        0,
        json.dumps({"streams": [], "format": {"tags": {}}}),
        "",
    )
    with (
        patch("apps.api.routers.comments.require_asset_access"),
        patch(
            "apps.api.routers.comments.s3_service.generate_internal_presigned_get_url",
            return_value="http://minio:9000/original/demo.mov",
        ),
        patch("subprocess.run", return_value=probe_result) as ffprobe,
    ):
        query = f"/assets/{asset.id}/comments/export?format=edl&version_id={version.id}"
        if start_mode == "explicit":
            query += "&start_tc=01:00:00:00"
        response = client.get(query, headers=auth_headers)

    assert response.status_code == 200
    assert "FCM: DROP FRAME" in response.text
    assert "01:00:02;16" in response.text
    assert (ffprobe.call_count == 0) is (start_mode == "explicit")


def test_edl_export_commits_before_probing_source_timecode(
    client, mock_db, auth_headers
):
    asset, version = _asset(), _version()
    media = _media(fps=29.97)
    media.s3_key_raw = "original/demo.mov"
    mock_db.first.side_effect = [asset, version, media]
    mock_db.order_by.return_value = mock_db
    mock_db.all.side_effect = [[_comment()]]

    events = []
    mock_db.commit.side_effect = lambda: events.append("commit")
    probe_result = subprocess.CompletedProcess(
        ["ffprobe"],
        0,
        json.dumps({"streams": [], "format": {"tags": {}}}),
        "",
    )

    def presign(*args, **kwargs):
        events.append("presign")
        return "http://minio:9000/original/demo.mov"

    def run(*args, **kwargs):
        events.append("ffprobe")
        return probe_result

    with (
        patch("apps.api.routers.comments.require_asset_access"),
        patch(
            "apps.api.routers.comments.s3_service.generate_internal_presigned_get_url",
            side_effect=presign,
        ),
        patch("subprocess.run", side_effect=run),
    ):
        response = client.get(
            f"/assets/{asset.id}/comments/export?format=edl&version_id={version.id}",
            headers=auth_headers,
        )

    assert response.status_code == 200
    assert events == ["commit", "presign", "ffprobe"]


@pytest.mark.parametrize("failure", ["timeout", "missing_ffprobe", "nonzero_exit"])
def test_source_timecode_probe_failures_return_none(failure):
    from apps.api.routers.comments import _probe_source_timecode

    media = MagicMock(id=uuid.uuid4(), s3_key_raw="original/demo.mov")
    if failure == "timeout":
        outcome = subprocess.TimeoutExpired("ffprobe", 15)
    elif failure == "missing_ffprobe":
        outcome = FileNotFoundError("ffprobe")
    else:
        outcome = subprocess.CompletedProcess(["ffprobe"], 1, "", "probe failed")

    with (
        patch(
            "apps.api.routers.comments.s3_service.generate_internal_presigned_get_url",
            return_value="http://minio:9000/original/demo.mov",
        ),
        patch("subprocess.run", side_effect=outcome)
        if isinstance(outcome, Exception)
        else patch("subprocess.run", return_value=outcome),
    ):
        assert _probe_source_timecode(media, MagicMock(timebase=30)) is None


def test_start_timecode_frame_must_be_within_timebase():
    from apps.api.routers.comments import _start_timecode_is_valid

    spec = MagicMock(timebase=24)
    assert _start_timecode_is_valid("00:00:00:23", spec)
    assert not _start_timecode_is_valid("00:00:00:24", spec)
