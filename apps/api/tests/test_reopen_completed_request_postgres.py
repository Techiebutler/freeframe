"""Auto-finish must not lock an editor out: a new file on a completed request reopens it.

An editor who waits for Hook1 to pass before adding Hook2 found the request closed and new files refused.
A reopen runs the normal review and finish flow again, keeps the result of files already finished, and
reports nothing twice: a new file is one new upload, the request finishes once for everyone downstream.
"""
import os
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

pytestmark = pytest.mark.skipif(not os.getenv('ITERATIONS_TEST_DATABASE_URL'), reason='opt-in local PostgreSQL check')


@pytest.fixture
def world(monkeypatch):
    from apps.api.database import Base
    from apps.api.models import User, Project, Folder, UploadRequest, ShareLink, AssetVersion
    from apps.api.models.asset import ProcessingStatus
    from apps.api.routers import requests as rq, upload as up
    from apps.api.services import hub_events, workflow_events
    admin = create_engine(os.environ['ITERATIONS_TEST_DATABASE_URL'])
    schema = 'reopen_test_' + uuid.uuid4().hex
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA {schema}'))
    engine = create_engine(os.environ['ITERATIONS_TEST_DATABASE_URL'], connect_args={'options': f'-csearch_path={schema}'})
    Session = sessionmaker(bind=engine, autoflush=False)
    for module in (rq, up):
        monkeypatch.setattr(module, 'complete_multipart_upload', lambda *a: None)
    monkeypatch.setattr(rq, 'create_multipart_upload', lambda *a: 'multipart')
    monkeypatch.setattr(rq, 'abort_multipart_upload', lambda *a: None)
    monkeypatch.setattr(rq, '_trigger_processing', lambda *a: None)
    monkeypatch.setattr(up, '_trigger_processing', lambda *a: None)
    monkeypatch.setattr(up, '_campaign_upload_access', lambda *a: None)
    s3 = MagicMock()
    s3.head_object.return_value = {'ContentLength': 100}
    monkeypatch.setattr(rq.s3_service, 'get_s3_client', lambda: s3)
    monkeypatch.setattr(rq.s3_service, 'generate_presigned_get_url', lambda key: 'https://media.example/' + key)

    # The review engine: a version on this list has passed, anything else is still being read.
    passed = set()
    def stats(ids, **_):
        out = {}
        with Session() as read:
            for aid in ids:
                latest = read.query(AssetVersion).filter(AssetVersion.asset_id == uuid.UUID(aid), AssetVersion.deleted_at.is_(None)).order_by(AssetVersion.version_number.desc()).first()
                done = latest is not None and str(latest.id) in passed
                out[aid] = {'watching': True, 'reviewed': done, 'version_id': str(latest.id) if done else None, 'openMustFix': 0,
                            'progress': {'stage': 'done' if done else 'waiting', 'version_id': str(latest.id) if done else None}}
        return out
    monkeypatch.setattr(rq.review_bridge, 'asset_stats', stats)
    monkeypatch.setattr(rq.review_bridge, 'request_status', lambda tokens: {t: {'status': 'clear' if not world_state['reviewing'] else 'reviewing', 'openMustFixes': 0} for t in tokens})
    world_state = {'reviewing': False}

    # The real report code runs; only the outgoing HTTP is captured.
    sent = []
    monkeypatch.setattr(hub_events.settings, 'hub_events_webhook_url', 'https://hub.example', raising=False)
    monkeypatch.setattr(hub_events.settings, 'portal_events_webhook_url', 'https://portal.example', raising=False)
    monkeypatch.setattr(workflow_events.settings, 'companydb_workflow_jwt', 'jwt', raising=False)
    monkeypatch.setattr(hub_events, '_deliver', lambda url, secret, event: sent.append(event['event']))
    monkeypatch.setattr(workflow_events, '_deliver', lambda body: sent.append(body['action']))

    Base.metadata.create_all(engine)
    db = Session()
    n = uuid.uuid4().hex[:8]
    owner = User(email=f'{n}@portal.example', name='Aditor Portal'); db.add(owner); db.flush()
    project = Project(name='Forward Health', created_by=owner.id); db.add(project); db.flush()
    folder = Folder(name='Card', project_id=project.id, created_by=owner.id); db.add(folder); db.flush()
    token, share = f'token-{n}', f'share-{n}'
    db.add(UploadRequest(token=token, review_share_token=share, title='Card', project_id=project.id, folder_id=folder.id,
                         created_by=owner.id, brand_slug='forward', iteration_state={'internal_handin': {'card_url': 'https://trello.com/c/AbCd1234'}}))
    db.add(ShareLink(token=share, folder_id=folder.id, created_by=owner.id, allow_download=True))
    db.commit()

    def req():
        return db.query(UploadRequest).filter_by(token=token).populate_existing().one()

    def initiate(name):
        return rq.guest_initiate(token, rq.GuestInitiate(original_filename=name, mime_type='video/mp4', file_size_bytes=100, name='Sandra', email='sandra@example.com'), db)

    def complete(init):
        out = rq.guest_complete(token, rq.GuestComplete(s3_key=init['s3_key'], upload_id='multipart', parts=[]), BackgroundTasks(), db)
        v = db.get(AssetVersion, uuid.UUID(init['version_id']))
        v.processing_status = ProcessingStatus.ready
        db.commit()
        return out

    def hand_in(name):
        init = initiate(name)
        complete(init)
        return init

    def pass_review(init):
        passed.add(init['version_id'])

    try:
        yield SimpleNamespace(rq=rq, up=up, db=db, token=token, req=req, initiate=initiate, complete=complete, hand_in=hand_in,
                              pass_review=pass_review, sent=sent, owner=owner, folder=folder, project=project, state=world_state)
    finally:
        db.close()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA {schema} CASCADE'))
        engine.dispose()
        admin.dispose()


def finished_with(w, name):
    init = w.hand_in(name)
    w.pass_review(init)
    w.rq.finish_request(w.token, w.db)
    assert w.req().completed_at is not None
    return init


def test_a_new_file_on_a_completed_request_reopens_it_and_the_finished_file_keeps_its_result(world):
    hook1 = finished_with(world, 'Hook1.mp4')
    hook2 = world.hand_in('Hook2.mp4')
    req = world.req()
    assert req.completed_at is None
    assert req.completion_versions is None
    world.state['reviewing'] = True
    review = world.rq._editor_review(world.db, req)
    states = {a['name']: a['review_state'] for a in review['assets']}
    assert states == {'Hook1': 'clear', 'Hook2': 'reviewing'}
    assert review['completed_at'] is None
    assert review['gate']['status'] == 'reviewing'
    with pytest.raises(HTTPException) as refused:
        world.rq.finish_request(world.token, world.db)
    assert refused.value.status_code == 409
    world.state['reviewing'] = False
    world.pass_review(hook2)
    finished = world.rq.finish_request(world.token, world.db)
    assert finished['completion_versions'] == {hook1['asset_id']: hook1['version_id'], hook2['asset_id']: hook2['version_id']}
    assert world.req().completed_at is not None


def test_starting_an_upload_does_not_reopen_only_a_file_that_arrived_does(world):
    finished_with(world, 'Hook1.mp4')
    closed_at = world.req().completed_at
    init = world.initiate('Hook2.mp4')
    assert world.req().completed_at == closed_at, 'an upload that may never finish must not undo a delivery'
    world.rq.guest_abort(world.token, world.rq.GuestPart(s3_key=init['s3_key'], upload_id='multipart', part_number=1), world.db)
    assert world.req().completed_at == closed_at


def test_a_transfer_already_running_when_the_request_closed_still_lands(world):
    hook1 = world.hand_in('Hook1.mp4')
    world.pass_review(hook1)
    running = world.initiate('Hook2.mp4')
    # Hook2 is `uploading`, so the gate holds finish; a request closed earlier by another tab is the same state.
    req = world.req()
    req.completed_at, req.completion_versions = datetime.now(timezone.utc), {hook1['asset_id']: hook1['version_id']}
    world.db.commit()
    world.complete(running)
    assert world.req().completed_at is None


def test_a_dead_transfer_left_on_a_finished_request_blocks_the_reopened_finish_until_it_is_removed(world):
    finished_with(world, 'Hook1.mp4')
    dead = world.initiate('Hook2.mp4')
    hook3 = world.hand_in('Hook3.mp4')
    world.pass_review(hook3)
    world.state['reviewing'] = True
    states = {a['name']: a['review_state'] for a in world.rq._editor_review(world.db, world.req())['assets']}
    assert states == {'Hook1': 'clear', 'Hook2': 'upload_incomplete', 'Hook3': 'clear'}
    with pytest.raises(HTTPException) as refused:
        world.rq.finish_request(world.token, world.db)
    assert refused.value.status_code == 409
    world.rq.guest_discard(world.token, world.rq.GuestDiscard(asset_id=dead['asset_id'], version_id=dead['version_id']), world.db)
    world.state['reviewing'] = False
    assert sorted(world.rq.finish_request(world.token, world.db)['completion_versions'].values()) == sorted(
        a['version_id'] for a in world.rq._editor_review(world.db, world.req())['assets'])


def test_a_reopen_sends_one_upload_report_per_new_file_and_finishes_once_downstream(world):
    finished_with(world, 'Hook1.mp4')
    assert sorted(world.sent) == ['handin.finished', 'handin.uploaded', 'handin_uploaded', 'revision_submitted']
    world.sent.clear()
    hook2 = world.initiate('Hook2.mp4')
    world.complete(hook2)
    # Retried complete: nothing again.
    world.rq.guest_complete(world.token, world.rq.GuestComplete(s3_key=hook2['s3_key'], upload_id='multipart', parts=[]), BackgroundTasks(), world.db)
    assert sorted(world.sent) == ['handin.uploaded', 'handin_uploaded', 'revision_submitted']
    world.sent.clear()
    world.pass_review(hook2)
    world.rq.finish_request(world.token, world.db)
    world.rq.finish_request(world.token, world.db)
    assert world.sent == [], 'the card was already reported finished once'


def test_a_request_finished_before_this_column_existed_is_not_reported_twice(world):
    hook1 = world.hand_in('Hook1.mp4')
    world.pass_review(hook1)
    req = world.req()
    req.completed_at, req.completion_versions = datetime.now(timezone.utc), {hook1['asset_id']: hook1['version_id']}
    world.db.commit()
    assert req.first_completed_at is None
    world.sent.clear()
    hook2 = world.hand_in('Hook2.mp4')
    world.pass_review(hook2)
    world.rq.finish_request(world.token, world.db)
    assert 'handin.finished' not in world.sent


def test_a_signed_in_upload_reopens_a_completed_request_and_does_not_report_a_second_finish(world):
    from apps.api.models import Asset, AssetVersion, MediaFile
    from apps.api.models.asset import AssetType, FileType, ProcessingStatus
    finished_with(world, 'Hook1.mp4')
    editor = world.owner
    asset = Asset(name='Hook2', project_id=world.project.id, folder_id=world.folder.id, asset_type=AssetType.video, created_by=editor.id); world.db.add(asset); world.db.flush()
    version = AssetVersion(asset_id=asset.id, version_number=1, processing_status=ProcessingStatus.uploading, created_by=editor.id); world.db.add(version); world.db.flush()
    world.db.add(MediaFile(version_id=version.id, file_type=FileType.video, original_filename='Hook2.mp4', mime_type='video/mp4', file_size_bytes=100, s3_key_raw='raw/hook2.mp4'))
    world.db.commit()
    world.up.complete_upload(SimpleNamespace(version_id=version.id, asset_id=asset.id, s3_key='raw/hook2.mp4', upload_id='u', parts=[]), BackgroundTasks(), world.db, editor)
    assert world.req().completed_at is None
    version.processing_status = ProcessingStatus.ready
    world.db.commit()
    world.pass_review({'version_id': str(version.id)})
    world.sent.clear()
    world.rq.finish_request(world.token, world.db)
    assert world.sent == []


def test_the_staff_handin_route_reopening_does_not_report_a_second_finish(world, monkeypatch):
    hook1 = finished_with(world, 'Hook1.mp4')
    req = world.req()
    # Exact-version completion disagrees with the latest file: the route that has always reopened in this case.
    req.completion_versions = {hook1['asset_id']: 'an-older-version'}
    world.db.commit()
    world.folder.description = 'https://trello.com/c/AbCd1234'
    world.project.is_workspace = True
    world.db.commit()
    monkeypatch.setattr(world.rq, 'require_project_role', lambda *a, **k: None)
    monkeypatch.setattr(world.rq, 'ensure_folder_assignment', lambda *a, **k: (world.req(), None))
    monkeypatch.setattr(world.rq, '_request_out', lambda *a, **k: {})
    world.rq.folder_editor_request(world.folder.id, world.db, SimpleNamespace(id=world.owner.id, is_staff=True))
    assert world.req().completed_at is None
    world.sent.clear()
    world.rq.finish_request(world.token, world.db)
    assert world.sent == []


def test_a_component_batch_stays_closed_once_complete(world):
    init = world.initiate('Hook1.mp4')
    req = world.req()
    req.receive_iterations, req.iteration_mode, req.iteration_manifest = True, 'components', {'slots': []}
    req.completed_at = datetime.now(timezone.utc)
    world.db.commit()
    with pytest.raises(HTTPException) as refused:
        world.rq.guest_complete(world.token, world.rq.GuestComplete(s3_key=init['s3_key'], upload_id='multipart', parts=[]), BackgroundTasks(), world.db)
    assert refused.value.status_code == 409
    world.db.rollback()
    with pytest.raises(HTTPException) as refused:
        world.initiate('Hook2.mp4')
    assert refused.value.status_code == 409
    assert world.req().completed_at is not None


def test_a_reopen_counts_each_file_once_on_campaign_usage(world, monkeypatch):
    from apps.api.models.campaign_review import CampaignReview
    from apps.api.services import campaign_usage
    campaign = {'id': uuid.uuid4().hex}
    monkeypatch.setattr(campaign_usage, 'context', lambda user: campaign)
    monkeypatch.setattr(campaign_usage, 'ENDS_AT_TIMESTAMP', 4102444800)
    finished_with(world, 'Hook1.mp4')
    hook2 = world.hand_in('Hook2.mp4')
    world.pass_review(hook2)
    world.db.commit()
    for _ in range(3):
        world.rq._editor_review(world.db, world.req())
    world.rq.finish_request(world.token, world.db)
    world.rq._editor_review(world.db, world.req())
    world.db.commit()
    assert world.db.query(CampaignReview).count() == 2
