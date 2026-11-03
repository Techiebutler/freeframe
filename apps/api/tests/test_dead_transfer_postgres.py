"""A transfer that is not running is never shown as a review (Sandra, QoBbPcQZ, 2026-11-03).

All 16 parts of Hook1 reached R2 in 39 seconds, then the tab went away while it waited for her details,
so /upload/complete never ran. The version stayed `uploading` for good: the reaper keeps request
versions and only a live tab holding the File can finish one. /r/<token> said "Review in progress",
with no way to upload it again or to add the other four hooks.
"""
import os
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

pytestmark = pytest.mark.skipif(not os.getenv('ITERATIONS_TEST_DATABASE_URL'), reason='opt-in local PostgreSQL check')

WHO = dict(name='Sandra', email='sandra@example.com')


@pytest.fixture
def world(monkeypatch):
    from apps.api.database import Base
    from apps.api.models import User, Project, Folder, UploadRequest, ShareLink
    from apps.api.routers import requests as rq
    from apps.api.services import campaign_access, hub_events, workflow_events
    admin = create_engine(os.environ['ITERATIONS_TEST_DATABASE_URL'])
    schema = 'dead_transfer_test_' + uuid.uuid4().hex
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA {schema}'))
    engine = create_engine(os.environ['ITERATIONS_TEST_DATABASE_URL'], connect_args={'options': f'-csearch_path={schema}'})
    Session = sessionmaker(bind=engine, autoflush=False)
    monkeypatch.setattr(rq, 'create_multipart_upload', lambda *a: 'upload-id')
    monkeypatch.setattr(rq, 'complete_multipart_upload', lambda *a: None)
    monkeypatch.setattr(rq, 'upload_guard_error', lambda *a: None)
    monkeypatch.setattr(campaign_access, 'require_project_access', lambda *a, **k: None)
    monkeypatch.setattr(hub_events, 'announce_revision_submitted', lambda *a, **k: None)
    monkeypatch.setattr(workflow_events, 'announce_handin_uploaded', lambda *a, **k: None)
    s3 = MagicMock()
    s3.head_object.return_value = {'ContentLength': 100}
    monkeypatch.setattr(rq.s3_service, 'get_s3_client', lambda: s3)
    monkeypatch.setattr(rq.s3_service, 'generate_presigned_get_url', lambda key: 'https://media.example/' + key)
    monkeypatch.setattr(rq.review_bridge, 'request_status', lambda tokens: {t: {'status': 'reviewing', 'openMustFixes': 0} for t in tokens})
    # What the bridge answers live for this asset: it watches the share, it has nothing to review.
    monkeypatch.setattr(rq.review_bridge, 'asset_stats', lambda ids, **k: {i: {'watching': True, 'reviewed': False, 'progress': {'stage': 'waiting'}} for i in ids})
    Base.metadata.create_all(engine)
    db = Session()
    n = uuid.uuid4().hex[:8]
    portal = User(email=f'{n}@portal.example', name='Aditor Portal'); db.add(portal); db.flush()
    project = Project(name='Forward Health', created_by=portal.id); db.add(project); db.flush()
    folder = Folder(name='QoBbPcQZ', project_id=project.id, created_by=portal.id); db.add(folder); db.flush()
    token, share = f'token-{n}', f'share-{n}'
    db.add(UploadRequest(token=token, review_share_token=share, title='QoBbPcQZ', project_id=project.id, folder_id=folder.id, created_by=portal.id))
    db.add(ShareLink(token=share, folder_id=folder.id, created_by=portal.id, allow_download=True))
    db.commit()

    def initiate(name='Hook1.mp4', **extra):
        return rq.guest_initiate(token, rq.GuestInitiate(original_filename=name, mime_type='video/mp4', file_size_bytes=100, **extra), db)

    def complete(init):
        return rq.guest_complete(token, rq.GuestComplete(s3_key=init['s3_key'], upload_id=init['upload_id'], parts=[{'PartNumber': 1, 'ETag': 'e'}], **WHO), BackgroundTasks(), db)

    try:
        yield SimpleNamespace(rq=rq, db=db, token=token, initiate=initiate, complete=complete,
                              review=lambda: rq.guest_review(token, db), view=lambda: rq.view_request(token, db))
    finally:
        db.close()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA {schema} CASCADE'))
        engine.dispose()
        admin.dispose()


def test_a_transfer_that_never_completed_is_not_a_review(world):
    world.initiate()
    review = world.review()
    entry = review['assets'][0]
    assert entry['processing'] == 'uploading'
    assert entry['review_state'] == 'upload_incomplete'
    assert entry['review_progress'] is None
    # Nothing was handed in, so nothing may close on it either.
    with pytest.raises(HTTPException) as refused:
        world.rq.finish_request(world.token, world.db)
    assert refused.value.status_code == 409
    assert review['gate']['status'] != 'clear'


def test_the_editor_can_upload_it_again_and_it_counts(world):
    first = world.initiate()
    again = world.initiate(asset_id=first['asset_id'])
    assert again['asset_id'] == first['asset_id'] and again['version_number'] == 2
    world.complete(again)
    entry = world.review()['assets'][0]
    assert entry['version'] == 2 and entry['processing'] == 'processing'
    assert entry['review_state'] == 'reviewing'


def test_the_remaining_files_can_be_added_beside_a_dead_one_and_after_a_finished_one(world):
    dead = world.initiate('Hook1.mp4')
    world.complete(world.initiate('Hook2.mp4'))
    world.initiate('Hook3.mp4')
    states = {a['name']: a['review_state'] for a in world.review()['assets']}
    assert states == {'Hook1': 'upload_incomplete', 'Hook2': 'reviewing', 'Hook3': 'upload_incomplete'}
    assert dead['version_number'] == 1


def test_discard_removes_a_dead_transfer_so_the_page_starts_over(world):
    first = world.initiate()
    world.rq.guest_discard(world.token, world.rq.GuestDiscard(asset_id=first['asset_id'], version_id=first['version_id']), world.db)
    assert world.view()['assets'] == []
    assert world.review()['assets'] == []


def test_discard_keeps_the_previous_version_of_a_revised_file(world):
    first = world.initiate()
    world.complete(first)
    revision = world.initiate(asset_id=first['asset_id'])
    world.rq.guest_discard(world.token, world.rq.GuestDiscard(asset_id=revision['asset_id'], version_id=revision['version_id']), world.db)
    entry = world.review()['assets'][0]
    assert entry['version'] == 1 and entry['processing'] == 'processing'


def test_discard_never_touches_a_file_that_really_arrived(world):
    first = world.initiate()
    world.complete(first)
    with pytest.raises(HTTPException) as refused:
        world.rq.guest_discard(world.token, world.rq.GuestDiscard(asset_id=first['asset_id'], version_id=first['version_id']), world.db)
    assert refused.value.status_code == 409
    assert len(world.view()['assets']) == 1


def test_discard_cannot_reach_another_request(world):
    first = world.initiate()
    with pytest.raises(HTTPException) as refused:
        world.rq.guest_discard(world.token, world.rq.GuestDiscard(asset_id=uuid.uuid4(), version_id=first['version_id']), world.db)
    assert refused.value.status_code == 404
