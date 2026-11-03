"""Editor completion requires the reviewed bytes, not an old green gate."""
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException

from apps.api.models.asset import Asset, AssetVersion, AssetType, ProcessingStatus
from apps.api.models.upload_request import UploadRequest, RequestUpload
from apps.api.routers import requests as rq


def request():
    return UploadRequest(id=uuid.uuid4(), token='t', project_id=uuid.uuid4(), folder_id=uuid.uuid4(),
                         created_by=uuid.uuid4(), title='Launch', review_share_token='s')


def test_transfer_can_start_without_identity_but_not_with_a_partial_identity():
    body = dict(original_filename='cut.mp4', mime_type='video/mp4', file_size_bytes=100)
    assert rq.GuestInitiate(**body).name is None
    with pytest.raises(ValueError):
        rq.GuestInitiate(**body, name='Editor')
    with pytest.raises(ValueError):
        rq.GuestInitiate(**body, name='   ', email='editor@example.com')


def test_exact_review_evidence_never_carries_v1_approval_into_v2():
    v = AssetVersion(id=uuid.uuid4(), version_number=2, processing_status=ProcessingStatus.ready)
    assert rq.editor_review_state(v, None) == 'unavailable'
    assert rq.editor_review_state(v, {'reviewed': True, 'versions': 2, 'openMustFix': 0}) == 'unavailable'
    evidence = {'reviewed': True, 'version_id': str(v.id), 'openMustFix': 0}
    assert rq.editor_review_state(v, evidence) == 'clear'
    assert rq.editor_review_state(v, {**evidence, 'version_id': str(uuid.uuid4())}) == 'reviewing'
    assert rq.editor_review_state(v, {**evidence, 'openMustFix': 1}) == 'held'
    v.processing_status = ProcessingStatus.processing
    assert rq.editor_review_state(v, evidence) == 'reviewing'


def test_complete_requires_identity_before_s3_finalization(monkeypatch):
    req = request()
    version = AssetVersion(id=uuid.uuid4(), asset_id=uuid.uuid4(), version_number=1, processing_status=ProcessingStatus.uploading)
    monkeypatch.setattr(rq, '_live_request', lambda *a, **kw: req)
    monkeypatch.setattr(rq, 'locked_request', lambda *a: req)
    monkeypatch.setattr(rq, '_owned_media', lambda *a: (MagicMock(), version))
    complete = MagicMock()
    monkeypatch.setattr(rq, 'complete_multipart_upload', complete)
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    db.query.return_value.filter.return_value.populate_existing.return_value.with_for_update.return_value.one.return_value = version
    with pytest.raises(HTTPException) as err:
        rq.guest_complete('t', rq.GuestComplete(s3_key='raw/a', upload_id='u', parts=[]), BackgroundTasks(), db)
    assert err.value.status_code == 422
    complete.assert_not_called()


@pytest.mark.parametrize('identity_at_initiate', [False, True])
def test_complete_submits_and_processes_with_deferred_or_existing_identity(monkeypatch, identity_at_initiate):
    from sqlalchemy.exc import NoResultFound
    req = request()
    version = AssetVersion(id=uuid.uuid4(), asset_id=uuid.uuid4(), version_number=1,
                           processing_status=ProcessingStatus.uploading)
    media = MagicMock(file_size_bytes=100)
    persisted = RequestUpload(request_id=req.id, asset_id=version.asset_id, version_number=1,
                              uploader_name='Editor', uploader_email='editor@example.com') if identity_at_initiate else None
    uploads, media_query = MagicMock(), MagicMock()
    uploads.filter.return_value = uploads
    uploads.first.return_value = persisted
    uploads.one.side_effect = NoResultFound() if persisted is None else None
    uploads.one.return_value = persisted
    media_query.filter.return_value.first.return_value = media
    db = MagicMock()
    versions = MagicMock()
    versions.filter.return_value.populate_existing.return_value.with_for_update.return_value.one.return_value = version
    db.query.side_effect = lambda model: uploads if model is RequestUpload else versions if model is AssetVersion else media_query
    db.scalar.return_value = datetime.now(timezone.utc)
    added = []
    db.add.side_effect = added.append
    monkeypatch.setattr(rq, '_live_request', lambda *a, **kw: req)
    monkeypatch.setattr(rq, 'locked_request', lambda *a: req)
    monkeypatch.setattr(rq, '_owned_media', lambda *a: (media, version))
    complete = MagicMock()
    monkeypatch.setattr(rq, 'complete_multipart_upload', complete)
    monkeypatch.setattr(rq.s3_service, 'get_s3_client', lambda: MagicMock(head_object=lambda **k: {'ContentLength': 100}))
    tasks = BackgroundTasks()
    identity = {} if identity_at_initiate else {'name': 'Editor', 'email': 'editor@example.com'}
    result = rq.guest_complete('t', rq.GuestComplete(s3_key='raw/a', upload_id='u', parts=[], **identity), tasks, db)
    record = persisted if identity_at_initiate else added[0]
    assert result['status'] == 'processing'
    assert record.uploader_name == 'Editor' and record.uploader_email == 'editor@example.com'
    assert record.submitted_at is not None
    assert version.processing_status == ProcessingStatus.processing
    assert len(tasks.tasks) == 1
    assert tasks.tasks[0].args == (version.asset_id, version.id)
    db.commit.assert_called_once()
    complete.assert_called_once_with('raw/a', 'u', [])


def test_finished_request_rejects_new_upload_but_remains_live(monkeypatch):
    req = request()
    req.completed_at = datetime.now(timezone.utc)
    assert rq.request_state(req, datetime.now(timezone.utc)) == 'live'
    monkeypatch.setattr(rq, '_live_request', lambda *a, **kw: req)
    monkeypatch.setattr(rq, 'locked_request', lambda *a: req)
    with pytest.raises(HTTPException) as err:
        rq.guest_initiate('t', rq.GuestInitiate(original_filename='cut.mp4', mime_type='video/mp4', file_size_bytes=100), MagicMock())
    assert err.value.status_code == 409


def test_version_lookup_rejects_foreign_asset_before_any_media_lookup(monkeypatch):
    req = request()
    monkeypatch.setattr(rq, '_live_request', lambda *a, **kw: req)
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    with pytest.raises(HTTPException) as err:
        rq.guest_version('t', uuid.uuid4(), uuid.uuid4(), db)
    assert err.value.status_code == 404


def test_finish_requires_every_current_asset_and_persists_exact_versions(monkeypatch):
    req = request()
    monkeypatch.setattr(rq, '_live_request', lambda *a, **kw: req)
    monkeypatch.setattr(rq, 'locked_request', lambda *a: req)
    data = {'assets': [{'asset_id': 'a', 'version_id': 'v2', 'review_state': 'reviewing'}],
            'gate': {'status': 'clear', 'open_must_fixes': 0}}
    monkeypatch.setattr(rq, '_editor_review', lambda *a: data)
    db = MagicMock()
    with pytest.raises(HTTPException) as err:
        rq.finish_request('t', db)
    assert err.value.status_code == 409
    assert req.completed_at is None
    data['assets'][0]['review_state'] = 'clear'
    result = rq.finish_request('t', db)
    assert result['completed_at']
    assert result['completion_versions'] == {'a': 'v2'}
    assert rq.finish_request('t', db) == result
    db.commit.assert_called_once()


def test_completed_version_cannot_be_aborted_into_failed(monkeypatch):
    req = request()
    version = AssetVersion(id=uuid.uuid4(), processing_status=ProcessingStatus.ready)
    monkeypatch.setattr(rq, '_live_request', lambda *a, **kw: req)
    monkeypatch.setattr(rq, 'locked_request', lambda *a: req)
    monkeypatch.setattr(rq, '_owned_media', lambda *a: (None, version))
    abort = MagicMock()
    monkeypatch.setattr(rq, 'abort_multipart_upload', abort)
    rq.guest_abort('t', rq.GuestPart(s3_key='raw/a', upload_id='u', part_number=1), MagicMock())
    abort.assert_not_called()
    assert version.processing_status == ProcessingStatus.ready


def test_old_version_objection_is_rejected_before_engine_call(monkeypatch):
    req = request()
    asset = Asset(id=uuid.uuid4(), folder_id=req.folder_id, project_id=req.project_id, asset_type=AssetType.video)
    current = AssetVersion(id=uuid.uuid4(), asset_id=asset.id, version_number=2, processing_status=ProcessingStatus.ready)
    monkeypatch.setattr(rq, '_live_request', lambda *a, **kw: req)
    monkeypatch.setattr(rq, 'locked_request', lambda *a: req)
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = asset
    db.query.return_value.filter.return_value.order_by.return_value.first.return_value = current
    engine = MagicMock()
    monkeypatch.setattr(rq.review_bridge, 'object_to_note', engine)
    with pytest.raises(HTTPException) as err:
        rq.guest_object('t', rq.GuestObjection(asset_id=asset.id, version_id=uuid.uuid4(), text='This was already fixed.'), db)
    assert err.value.status_code == 409
    engine.assert_not_called()


def test_request_rejects_media_the_automatic_reviewer_cannot_verify(monkeypatch):
    req = request()
    monkeypatch.setattr(rq, '_live_request', lambda *a, **kw: req)
    monkeypatch.setattr(rq, 'locked_request', lambda *a: req)
    start = MagicMock()
    monkeypatch.setattr(rq, 'upload_guard_error', lambda *a: None)
    monkeypatch.setattr(rq, 'create_multipart_upload', start)
    with pytest.raises(HTTPException) as err:
        rq.guest_initiate('t', rq.GuestInitiate(original_filename='photo.jpg', mime_type='image/jpeg', file_size_bytes=100), MagicMock())
    assert err.value.status_code == 400
    assert 'video' in err.value.detail.lower()
    start.assert_not_called()


def test_existing_thumbnails_are_exposed_but_audio_waveforms_are_not_images(monkeypatch):
    from apps.api.models.asset import MediaFile
    req = request()
    asset = Asset(id=uuid.uuid4(), name='Cut', asset_type=AssetType.video)
    version = AssetVersion(id=uuid.uuid4(), version_number=2, processing_status=ProcessingStatus.processing)
    media = MediaFile(version_id=version.id, s3_key_raw='v2/raw.mp4', s3_key_thumbnail='v2/thumb.jpg')
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = media
    monkeypatch.setattr(rq.s3_service, 'generate_presigned_get_url', lambda key: 'signed/' + key)
    result = rq._version_review(db, req, asset, version, None, None)
    assert result['thumbnail_url'] == 'signed/v2/thumb.jpg'
    assert result['media_url'] == 'signed/v2/raw.mp4'
    media.s3_key_thumbnail = None
    assert rq._version_review(db, req, asset, version, None, None)['thumbnail_url'] is None
    asset.asset_type = AssetType.audio
    media.s3_key_thumbnail = 'waveform.json'
    assert rq._version_review(db, req, asset, version, None, None)['thumbnail_url'] is None



@pytest.mark.parametrize('count', [True, False, -1, 0.5, None, '0'])
def test_invalid_must_fix_counter_never_clears(count):
    v = AssetVersion(id=uuid.uuid4(), processing_status=ProcessingStatus.ready)
    assert rq.editor_review_state(v, {'version_id': str(v.id), 'reviewed': True, 'openMustFix': count}) == 'unavailable'


@pytest.mark.parametrize('states,bridge,want', [
    (['clear'], None, 'unavailable'),
    (['clear'], {}, 'unavailable'),
    (['clear'], {'status': 'clear', 'openMustFixes': True}, 'unavailable'),
    (['reviewing'], {'status': 'clear', 'openMustFixes': 0}, 'reviewing'),
    (['unavailable'], {'status': 'clear', 'openMustFixes': 0}, 'unavailable'),
    (['held', 'unavailable', 'reviewing'], None, 'held'),
    (['clear', 'clear'], {'status': 'clear', 'openMustFixes': 0}, 'clear'),
    ([], {'status': 'clear', 'openMustFixes': 0}, 'reviewing'),
])
def test_owner_never_ready_for_missing_or_stale_review(states, bridge, want):
    assets = [{'review_state': state, 'comments': []} for state in states]
    assert rq._request_gate(assets, bridge)['status'] == want


def test_visible_must_fix_overrides_clear():
    assets = [{'review_state': 'clear', 'comments': [{'must_fix': True}]}]
    assert rq._request_gate(assets, {'status': 'clear', 'openMustFixes': 0}) == {'status': 'held', 'open_must_fixes': 1}


def test_unavailable_review_does_not_finish(monkeypatch):
    req = request()
    monkeypatch.setattr(rq, '_live_request', lambda *a, **kw: req)
    monkeypatch.setattr(rq, 'locked_request', lambda *a: req)
    monkeypatch.setattr(rq, '_editor_review', lambda *a: {'assets': [{'asset_id':'a','version_id':'v2','review_state':'unavailable'}], 'gate': {'status':'unavailable','open_must_fixes':0}})
    with pytest.raises(HTTPException) as err: rq.finish_request('t', MagicMock())
    assert err.value.status_code == 409 and req.completed_at is None


def test_unmeasured_object_never_becomes_submitted(monkeypatch):
    req = request()
    v = AssetVersion(id=uuid.uuid4(), asset_id=uuid.uuid4(), version_number=1, processing_status=ProcessingStatus.uploading)
    record = RequestUpload(request_id=req.id, asset_id=v.asset_id, version_number=1, uploader_name='Editor', uploader_email='editor@example.com')
    media = MagicMock(file_size_bytes=100)
    monkeypatch.setattr(rq, '_live_request', lambda *a, **kw: req)
    monkeypatch.setattr(rq, 'locked_request', lambda *a: req)
    monkeypatch.setattr(rq, '_owned_media', lambda *a: (media, v))
    monkeypatch.setattr(rq, '_record_uploader', lambda *a: record)
    monkeypatch.setattr(rq, 'complete_multipart_upload', lambda *a: None)
    monkeypatch.setattr(rq.s3_service, 'get_s3_client', lambda: MagicMock(head_object=MagicMock(side_effect=RuntimeError('storage unavailable'))))
    db = MagicMock(); db.query.return_value.filter.return_value.first.return_value = media
    db.query.return_value.filter.return_value.one.return_value = record
    db.query.return_value.filter.return_value.populate_existing.return_value.with_for_update.return_value.one.return_value = v
    with pytest.raises(HTTPException) as err:
        rq.guest_complete('t', rq.GuestComplete(s3_key='raw/a',upload_id='u',parts=[]), BackgroundTasks(), db)
    assert err.value.status_code == 503
    assert record.submitted_at is None and v.processing_status == ProcessingStatus.uploading

@pytest.mark.parametrize('stage', ['reading', 'waiting'])
def test_pending_review_does_not_require_a_finished_version_id(stage):
    v = AssetVersion(id=uuid.uuid4(), version_number=1, processing_status=ProcessingStatus.ready)
    evidence = {'reviewed': False, 'version_id': None, 'progress': {'stage': stage, 'version_id': str(v.id)}}
    assert rq.editor_review_state(v, evidence) == 'reviewing'

@pytest.mark.parametrize('stage', ['failed', 'skipped'])
def test_failed_review_is_not_presented_as_running(stage):
    v = AssetVersion(id=uuid.uuid4(), version_number=1, processing_status=ProcessingStatus.ready)
    evidence = {'reviewed': False, 'version_id': str(v.id), 'progress': {'stage': stage, 'version_id': str(v.id)}}
    assert rq.editor_review_state(v, evidence) == 'unavailable'

def test_pending_progress_cannot_clear_a_new_version():
    v = AssetVersion(id=uuid.uuid4(), version_number=2, processing_status=ProcessingStatus.ready)
    evidence = {'reviewed': True, 'version_id': str(uuid.uuid4()), 'openMustFix': 0,
                'progress': {'stage': 'reading', 'version_id': str(uuid.uuid4())}}
    assert rq.editor_review_state(v, evidence) == 'unavailable'

@pytest.mark.parametrize('watching,expected', [(True, 'reviewing'), (False, 'unavailable')])
def test_stale_progress_only_waits_with_a_registered_watch(watching, expected):
    v = AssetVersion(id=uuid.uuid4(), version_number=2, processing_status=ProcessingStatus.ready)
    assert rq.editor_review_state(v, {'reviewed': False, 'version_id': None, 'watching': watching,
        'progress': {'stage': 'reading', 'version_id': str(uuid.uuid4())}}) == expected


def test_only_a_running_or_finished_transfer_can_read_as_a_review():
    v = AssetVersion(id=uuid.uuid4(), version_number=1, processing_status=ProcessingStatus.uploading)
    assert rq.editor_review_state(v, {'watching': True, 'reviewed': False, 'progress': {'stage': 'waiting'}}) == 'upload_incomplete'
    v.processing_status = ProcessingStatus.processing
    assert rq.editor_review_state(v, {'watching': True, 'reviewed': False, 'progress': {'stage': 'waiting'}}) == 'reviewing'
    v.processing_status = ProcessingStatus.failed
    assert rq.editor_review_state(v, None) == 'unavailable'
    assert rq.editor_review_state(None, None) == 'reviewing'


def test_a_dead_transfer_keeps_the_gate_open_and_never_clears_it():
    gate = rq._request_gate([{'review_state': 'clear'}, {'review_state': 'upload_incomplete'}], {'status': 'clear', 'openMustFixes': 0})
    assert gate == {'status': 'reviewing', 'open_must_fixes': 0}
