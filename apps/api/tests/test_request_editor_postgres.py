"""Actual staged upload/version/completion writes; no real storage or reviewer calls."""
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

pytestmark = pytest.mark.skipif(not os.getenv('ITERATIONS_TEST_DATABASE_URL'), reason='opt-in local PostgreSQL check')


def test_staged_revision_history_and_serialized_completion(monkeypatch):
    from apps.api.database import Base
    from apps.api.models import User, Project, Folder, UploadRequest, Asset, AssetVersion, RequestUpload, MediaFile, ShareLink
    from apps.api.models.project import ProjectMember, ProjectRole
    from apps.api.models.asset import ProcessingStatus
    from apps.api.routers import requests as rq
    admin = create_engine(os.environ['ITERATIONS_TEST_DATABASE_URL'])
    schema = 'editor_test_' + uuid.uuid4().hex
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA {schema}'))
    engine = create_engine(os.environ['ITERATIONS_TEST_DATABASE_URL'], connect_args={'options': f'-csearch_path={schema}'})
    # Match production: pending additions cannot be found by a query until flushed.
    Session = sessionmaker(bind=engine, autoflush=False)
    monkeypatch.setattr(rq, 'upload_guard_error', lambda *a: None)
    monkeypatch.setattr(rq, 'create_multipart_upload', lambda *a: 'multipart')
    monkeypatch.setattr(rq, 'complete_multipart_upload', lambda *a: None)
    monkeypatch.setattr(rq.s3_service, 'get_s3_client', lambda: MagicMock(head_object=lambda **k: {'ContentLength': 100}))
    monkeypatch.setattr(rq.s3_service, 'generate_presigned_get_url', lambda key: 'https://media.example/' + key)
    stats = {}
    monkeypatch.setattr(rq.review_bridge, 'asset_stats', lambda *a, **kw: stats)
    monkeypatch.setattr(rq.review_bridge, 'request_status', lambda *a: {'share': {'status': 'clear', 'openMustFixes': 0}})
    try:
        Base.metadata.create_all(engine)
        with Session() as db:
            owner = User(email='owner@example.test', name='Owner'); db.add(owner); db.flush()
            project = Project(name='Brand', created_by=owner.id); db.add(project); db.flush()
            # create_project grants its creator an owner membership; model fixtures must too.
            db.add(ProjectMember(project_id=project.id, user_id=owner.id, role=ProjectRole.owner))
            folder = Folder(name='Hand in', project_id=project.id, created_by=owner.id); db.add(folder); db.flush()
            req = UploadRequest(token='token', review_share_token='share', title='Launch', project_id=project.id, folder_id=folder.id, created_by=owner.id)
            db.add(req)
            db.add(ShareLink(token='share', folder_id=folder.id, created_by=owner.id, allow_download=True))
            db.commit()
            init = rq.guest_initiate('token', rq.GuestInitiate(original_filename='cut.mp4', mime_type='video/mp4', file_size_bytes=100), db)
            assert db.query(RequestUpload).count() == 0
            with pytest.raises(HTTPException) as missing:
                rq.guest_complete('token', rq.GuestComplete(s3_key=init['s3_key'], upload_id='multipart', parts=[]), BackgroundTasks(), db)
            assert missing.value.status_code == 422
            db.rollback()
            rq.guest_complete('token', rq.GuestComplete(s3_key=init['s3_key'], upload_id='multipart', parts=[], name='Jamie', email='jamie@example.com'), BackgroundTasks(), db)
            assert db.query(RequestUpload).one().uploader_name == 'Jamie'
            assert db.query(RequestUpload).one().submitted_at is not None
            v1 = db.get(AssetVersion, uuid.UUID(init['version_id'])); v1.processing_status = ProcessingStatus.ready
            db.query(MediaFile).filter_by(version_id=v1.id).one().s3_key_processed = 'hls/prefix-not-an-object/'
            db.commit()
            stats[init['asset_id']] = {'version_id': init['version_id'], 'reviewed': True, 'openMustFix': 0}
            revision = rq.guest_initiate('token', rq.GuestInitiate(asset_id=init['asset_id'], original_filename='entirely-renamed-v2.mp4', mime_type='video/mp4', file_size_bytes=100, name='Jamie', email='jamie@example.com'), db)
            assert revision['asset_id'] == init['asset_id'] and revision['version_number'] == 2
            assert db.query(Asset).count() == 1
            # Complete holds the same row lock as finish until submitted bytes are committed.
            completing, allow_complete, trying_finish = Event(), Event(), Event()
            def store(*args):
                completing.set(); assert allow_complete.wait(5)
            monkeypatch.setattr(rq, 'complete_multipart_upload', store)
            def complete_revision():
                with Session() as other:
                    return rq.guest_complete('token', rq.GuestComplete(s3_key=revision['s3_key'], upload_id='multipart', parts=[]), BackgroundTasks(), other)
            def finish_during_complete():
                trying_finish.set()
                with Session() as other:
                    with pytest.raises(HTTPException) as blocked: rq.finish_request('token', other)
                    return blocked.value.status_code
            with ThreadPoolExecutor(max_workers=2) as pool:
                stored = pool.submit(complete_revision)
                assert completing.wait(5)
                closing = pool.submit(finish_during_complete)
                assert trying_finish.wait(5)
                allow_complete.set()
                assert stored.result(5)['version_id'] == revision['version_id']
                assert closing.result(5) == 409
            db.expire_all()
            review = rq.guest_review('token', db)
            assert review['assets'][0]['version_id'] == revision['version_id']
            assert review['assets'][0]['comments'] == [] and review['gate']['status'] == 'reviewing'
            old = rq.guest_version('token', uuid.UUID(init['asset_id']), uuid.UUID(init['version_id']), db)
            assert init['version_id'] in old['media_url']
            with pytest.raises(HTTPException): rq.finish_request('token', db)
            db.rollback()
            v2 = db.get(AssetVersion, uuid.UUID(revision['version_id']))
            v2.processing_status = ProcessingStatus.failed
            from datetime import datetime, timezone, timedelta
            v2.created_at = datetime.now(timezone.utc) - timedelta(days=1)
            db.commit()
            from apps.api.tasks import cleanup_tasks
            monkeypatch.setattr(cleanup_tasks, 'list_stale_multipart_uploads', lambda *a: [])
            monkeypatch.setattr(cleanup_tasks, 'delete_object', lambda *a: None)
            monkeypatch.setattr(cleanup_tasks, 'delete_prefix', lambda *a: None)
            cleanup_tasks._reap_stale_uploads(db); db.commit()
            assert v2.deleted_at is None
            failed = rq.guest_review('token', db)
            assert failed['assets'][0]['version_id'] == revision['version_id']
            assert failed['gate']['status'] == 'unavailable'
            assert rq.list_requests(None, db, owner)[0]['status'] == 'unavailable'
            with pytest.raises(HTTPException) as blocked: rq.finish_request('token', db)
            assert blocked.value.status_code == 409
            db.rollback()
            v2.processing_status = ProcessingStatus.ready; db.commit()
            stats[init['asset_id']] = {'version_id': revision['version_id'], 'reviewed': True, 'openMustFix': 0}
            abandoned = rq.guest_initiate('token', rq.GuestInitiate(original_filename='cancelled.mp4', mime_type='video/mp4', file_size_bytes=100), db)
            monkeypatch.setattr(rq, 'abort_multipart_upload', lambda *a: None)
            rq.guest_abort('token', rq.GuestPart(s3_key=abandoned['s3_key'], upload_id='multipart', part_number=1), db)
            assert len(rq.view_request('token', db)['assets']) == 1
            assert db.get(Asset, uuid.UUID(abandoned['asset_id'])).deleted_at is not None
            from apps.api.routers.share import get_folder_share_assets
            shared = get_folder_share_assets('share', None, 1, 50, None, db, None)
            assert [str(a.id) for a in shared.assets] == [init['asset_id']]
            # Canceling revisions retains the delivered asset and never reuses a unique number.
            canceled_v3 = rq.guest_initiate('token', rq.GuestInitiate(asset_id=init['asset_id'], original_filename='cancel-v3.mp4', mime_type='video/mp4', file_size_bytes=100), db)
            rq.guest_abort('token', rq.GuestPart(s3_key=canceled_v3['s3_key'], upload_id='multipart', part_number=1), db)
            assert db.get(Asset, uuid.UUID(init['asset_id'])).deleted_at is None
            retry_v4 = rq.guest_initiate('token', rq.GuestInitiate(asset_id=init['asset_id'], original_filename='retry-v4.mp4', mime_type='video/mp4', file_size_bytes=100), db)
            assert retry_v4['version_number'] == 4
            rq.guest_abort('token', rq.GuestPart(s3_key=retry_v4['s3_key'], upload_id='multipart', part_number=1), db)
        # A simultaneous initiation waits for the completion lock. It may start (the file reopens the request
        # only when it lands), and it never changes what the finish just froze.
        checking, release = Event(), Event()
        def evidence(*args, **kwargs):
            checking.set(); assert release.wait(5); return stats
        monkeypatch.setattr(rq.review_bridge, 'asset_stats', evidence)
        def finish():
            with Session() as db: return rq.finish_request('token', db)
        def initiate():
            with Session() as db:
                return rq.guest_initiate('token', rq.GuestInitiate(original_filename='late.mp4', mime_type='video/mp4', file_size_bytes=100), db)
        with ThreadPoolExecutor(max_workers=2) as pool:
            finished = pool.submit(finish)
            assert checking.wait(5)
            late = pool.submit(initiate)
            release.set()
            assert finished.result(5)['completion_versions'] == {init['asset_id']: revision['version_id']}
            assert late.result(5)['version_number'] == 1
        with Session() as db:
            assert rq.view_request('token', db)['completed_at']
            assert db.query(Asset).count() == 3  # cancelled history preserved, excluded from completion; plus the late file
    finally:
        engine.dispose()
        with admin.begin() as conn: conn.execute(text(f'DROP SCHEMA {schema} CASCADE'))
        admin.dispose()


def test_completion_migration_backfills_only_proven_transfers():
    import importlib.util
    from pathlib import Path
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    path = Path(__file__).parents[1] / 'alembic/versions/d0e1f2a3b4c5_request_completion.py'
    spec = importlib.util.spec_from_file_location('request_completion_migration', path)
    migration = importlib.util.module_from_spec(spec); spec.loader.exec_module(migration)
    engine = create_engine(os.environ['ITERATIONS_TEST_DATABASE_URL'])
    schema = 'migration_test_' + uuid.uuid4().hex
    try:
        with engine.connect() as conn, conn.begin() as transaction:
            conn.execute(text(f'CREATE SCHEMA {schema}; SET LOCAL search_path TO {schema}'))
            conn.execute(text('CREATE TABLE upload_requests (id uuid); CREATE TABLE request_uploads (asset_id uuid, version_number integer, created_at timestamptz); CREATE TABLE asset_versions (asset_id uuid, version_number integer, deleted_at timestamptz, processing_status text)'))
            for number, state in enumerate(['uploading', 'processing', 'ready', 'failed'], 1):
                conn.execute(text("INSERT INTO request_uploads VALUES (:asset, :number, now()); INSERT INTO asset_versions VALUES (:asset, :number, NULL, :state)"), {'asset': str(uuid.uuid4()), 'number': number, 'state': state})
            with Operations.context(MigrationContext.configure(conn)):
                migration.upgrade()
            assert conn.execute(text('SELECT version_number FROM request_uploads WHERE submitted_at IS NOT NULL ORDER BY version_number')).scalars().all() == [2, 3]
            transaction.rollback()  # synthetic schema and DDL never survive this test
    finally:
        engine.dispose()
