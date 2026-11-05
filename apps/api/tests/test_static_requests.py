"""Static ads (1:1 PNGs) in a request: accepted at upload, never stuck waiting for the video reviewer."""
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from apps.api.models.asset import Asset, AssetType, AssetVersion, ProcessingStatus
from apps.api.models.upload_request import UploadRequest


def _req():
    r = UploadRequest(token="t", project_id=uuid.uuid4(), folder_id=uuid.uuid4(), created_by=uuid.uuid4(),
                      title="Statics", review_share_token="s")
    r.revoked_at = None
    r.expires_at = None
    return r


def _db():
    q = MagicMock()
    q.filter.return_value = q
    q.order_by.return_value = q
    q.first.return_value = None
    q.all.return_value = []
    db = MagicMock()
    db.query.return_value = q
    return db


@pytest.fixture
def initiate(monkeypatch):
    from apps.api.routers import requests as rq
    req = _req()
    monkeypatch.setattr(rq, '_writable_request', lambda db, token: req)
    monkeypatch.setattr(rq, 'create_multipart_upload', lambda *a: 'upload-id')
    monkeypatch.setattr(rq, 'upload_guard_error', lambda *a: None)

    def go(mime, name='ad.png'):
        db = _db()
        out = rq.guest_initiate('t', rq.GuestInitiate(original_filename=name, mime_type=mime, file_size_bytes=100), db)
        return out, db
    return go


@pytest.mark.parametrize('mime', ['image/png', 'image/jpeg', 'image/webp'])
def test_a_static_image_upload_is_accepted(initiate, mime):
    out, db = initiate(mime)
    assert out['upload_id'] == 'upload-id'
    asset = next(c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], Asset))
    assert asset.asset_type == AssetType.image


@pytest.mark.parametrize('mime', ['image/gif', 'image/tiff', 'application/pdf'])
def test_other_files_are_still_refused(initiate, mime):
    with pytest.raises(HTTPException) as exc:
        initiate(mime, 'x.bin')
    assert exc.value.status_code == 400


def test_a_ready_image_is_clear_without_the_video_reviewer():
    from apps.api.routers import requests as rq
    asset = Asset(id=uuid.uuid4(), project_id=uuid.uuid4(), name='Ad1', asset_type=AssetType.image, created_by=uuid.uuid4())
    version = AssetVersion(id=uuid.uuid4(), asset_id=asset.id, version_number=1, processing_status=ProcessingStatus.ready, created_by=uuid.uuid4())
    db = _db()
    entry = rq._version_review(db, _req(), asset, version, None, None, include_media=False)
    assert entry['review_state'] == 'clear'
    assert entry['review_error'] is None
    assert entry['asset_type'] == 'image'


def test_an_image_still_processing_is_reviewing_not_clear():
    from apps.api.routers import requests as rq
    asset = Asset(id=uuid.uuid4(), project_id=uuid.uuid4(), name='Ad1', asset_type=AssetType.image, created_by=uuid.uuid4())
    version = AssetVersion(id=uuid.uuid4(), asset_id=asset.id, version_number=1, processing_status=ProcessingStatus.processing, created_by=uuid.uuid4())
    entry = rq._version_review(_db(), _req(), asset, version, None, None, include_media=False)
    assert entry['review_state'] == 'reviewing'


def test_a_request_of_only_ready_statics_is_clear_even_if_the_bridge_is_silent():
    from apps.api.routers.requests import _request_gate
    statics = [{'asset_type': 'image', 'review_state': 'clear', 'comments': []}] * 3
    assert _request_gate(statics, None) == {'status': 'clear', 'open_must_fixes': 0}
    statics.append({'asset_type': 'image', 'review_state': 'reviewing', 'comments': []})
    assert _request_gate(statics, None)['status'] == 'reviewing'


def test_videos_still_need_the_bridge():
    from apps.api.routers.requests import _request_gate
    assert _request_gate([{'asset_type': 'video', 'review_state': 'clear', 'comments': []}], None)['status'] == 'unavailable'
