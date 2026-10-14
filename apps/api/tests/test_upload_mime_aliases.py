"""Browser MIME spellings accepted by POST /upload/initiate (#484).

The web client sends File.type as is. These are the values real browsers
report for files FreeFrame can process, measured with Playwright 1.59 on
macOS (Chromium 147, WebKit 26.4). A .wav from Safari arrived as
audio/x-wav and was refused with "Unsupported file type: audio/x-wav".
"""
import uuid
from unittest.mock import MagicMock

import pytest

import apps.api.routers.upload as upload_module
from apps.api.models.asset import AssetType
from apps.api.schemas.upload import ALLOWED_MIME_TYPES, mime_to_asset_type

# (browser-reported type, extension, asset type it must become)
BROWSER_TYPES = [
    ("audio/wav", "wav", AssetType.audio),        # Chromium .wav
    ("audio/x-wav", "wav", AssetType.audio),      # WebKit/Safari .wav (the #484 report)
    ("audio/vnd.wave", "bwf", AssetType.audio),   # Chromium + WebKit .bwf
    ("audio/wave", "wav", AssetType.audio),
    ("audio/aiff", "aiff", AssetType.audio),      # Chromium .aif/.aiff
    ("audio/x-aiff", "aiff", AssetType.audio),    # WebKit .aif/.aiff/.aifc
    ("audio/flac", "flac", AssetType.audio),
    ("audio/x-flac", "flac", AssetType.audio),
    ("audio/x-m4a", "m4a", AssetType.audio),      # Chromium + WebKit .m4a
    ("audio/mp4", "m4a", AssetType.audio),
    ("video/matroska", "mkv", AssetType.video),   # Chromium .mkv
    ("video/avi", "avi", AssetType.video),        # Chromium .avi
    ("video/x-m4v", "m4v", AssetType.video),      # WebKit .m4v
]


@pytest.mark.parametrize("mime_type,_ext,expected", BROWSER_TYPES)
def test_browser_mime_type_is_allowed_and_typed(mime_type, _ext, expected):
    assert mime_type in ALLOWED_MIME_TYPES
    assert mime_to_asset_type(mime_type) == expected


@pytest.mark.parametrize("mime_type,ext,expected", BROWSER_TYPES)
def test_initiate_accepts_browser_mime_type(
    client, auth_headers, mock_db, test_user, monkeypatch, mime_type, ext, expected
):
    monkeypatch.setattr(upload_module, "upload_guard_error", lambda db, n: None)
    monkeypatch.setattr(upload_module, "choose_part_size", lambda db, n: (10 * 1024 * 1024, None))
    monkeypatch.setattr(upload_module, "require_project_role", lambda db, pid, u, r: None)
    monkeypatch.setattr(upload_module, "create_multipart_upload", lambda key, mt: "fake-upload-id")
    mock_db.first.side_effect = [MagicMock(), None]  # project, then no prior version

    added = []

    def _add(obj):
        if getattr(obj, "id", None) is None:
            obj.id = uuid.uuid4()
        added.append(obj)

    mock_db.add.side_effect = _add

    resp = client.post(
        "/upload/initiate",
        json={
            "project_id": str(uuid.uuid4()),
            "asset_name": "mix",
            "original_filename": f"mix.{ext}",
            "mime_type": mime_type,
            "file_size_bytes": 1440102,
        },
        headers=auth_headers,
    )

    assert resp.status_code == 200, resp.text
    asset = next(o for o in added if type(o).__name__ == "Asset")
    assert asset.asset_type == expected
