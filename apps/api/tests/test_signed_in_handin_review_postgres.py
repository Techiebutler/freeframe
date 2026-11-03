"""A signed-in editor's upload into a hand-in folder is a submission like a guest's.

Live 2026-11-02 (Mika on Levide, Saskia on Veda, alfredo on EcomPro): the file landed, the portal got
its hand-in, and /r/<token> said "Review unavailable" for good, because only the guest route wrote the
RequestUpload row that `_review_assets` reads as proof of the transfer.
"""
import os
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

pytestmark = pytest.mark.skipif(not os.getenv('ITERATIONS_TEST_DATABASE_URL'), reason='opt-in local PostgreSQL check')


@pytest.fixture
def world(monkeypatch):
    from apps.api.database import Base
    from apps.api.models import User, Project, Folder, UploadRequest, Asset, AssetVersion, MediaFile, ShareLink
    from apps.api.models.asset import AssetType, ProcessingStatus, FileType
    from apps.api.routers import requests as rq, upload as up
    from apps.api.services import hub_events, workflow_events
    admin = create_engine(os.environ['ITERATIONS_TEST_DATABASE_URL'])
    schema = 'signed_in_test_' + uuid.uuid4().hex
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA {schema}'))
    engine = create_engine(os.environ['ITERATIONS_TEST_DATABASE_URL'], connect_args={'options': f'-csearch_path={schema}'})
    Session = sessionmaker(bind=engine, autoflush=False)
    monkeypatch.setattr(up, 'complete_multipart_upload', lambda *a: None)
    monkeypatch.setattr(up, '_campaign_upload_access', lambda *a: None)
    monkeypatch.setattr(hub_events, 'announce_revision_submitted', lambda *a, **k: None)
    monkeypatch.setattr(workflow_events, 'announce_handin_uploaded', lambda *a, **k: None)
    monkeypatch.setattr(rq.s3_service, 'generate_presigned_get_url', lambda key: 'https://media.example/' + key)
    monkeypatch.setattr(rq.review_bridge, 'request_status', lambda tokens: {t: {'status': 'reviewing', 'openMustFixes': 0} for t in tokens})
    # What the live bridge answers for a file it is watching: only the missing row turned this into "unavailable".
    monkeypatch.setattr(rq.review_bridge, 'asset_stats', lambda ids, **k: {i: {'watching': True, 'reviewed': False, 'progress': {'stage': 'waiting'}} for i in ids})
    Base.metadata.create_all(engine)
    db = Session()

    def folder_with_upload(*, with_request=True):
        n = uuid.uuid4().hex[:8]
        editor = User(email=f'{n}@editors.example', name='Mika'); db.add(editor); db.flush()
        project = Project(name='Levide', created_by=editor.id); db.add(project); db.flush()
        folder = Folder(name='Card', project_id=project.id, created_by=editor.id); db.add(folder); db.flush()
        token = f'token-{n}'
        share = f'share-{n}'
        if with_request:
            db.add(UploadRequest(token=token, review_share_token=share, title='Card', project_id=project.id, folder_id=folder.id, created_by=editor.id))
            db.add(ShareLink(token=share, folder_id=folder.id, created_by=editor.id, allow_download=True))
        asset = Asset(name='hook1.mp4', project_id=project.id, folder_id=folder.id, asset_type=AssetType.video, created_by=editor.id); db.add(asset); db.flush()
        version = AssetVersion(asset_id=asset.id, version_number=1, processing_status=ProcessingStatus.uploading, created_by=editor.id); db.add(version); db.flush()
        key = f'raw/{n}.mp4'
        db.add(MediaFile(version_id=version.id, file_type=FileType.video, original_filename='hook1.mp4', mime_type='video/mp4', file_size_bytes=100, s3_key_raw=key))
        db.commit()
        return SimpleNamespace(token=token, editor=editor, asset=asset, version=version, key=key, up=up, rq=rq, db=db)

    try:
        yield folder_with_upload
    finally:
        db.close()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA {schema} CASCADE'))
        engine.dispose()
        admin.dispose()


def _complete(w):
    body = SimpleNamespace(version_id=w.version.id, asset_id=w.asset.id, s3_key=w.key, upload_id='u', parts=[])
    return w.up.complete_upload(body, BackgroundTasks(), w.db, w.editor)


def test_signed_in_upload_into_a_handin_folder_is_a_submission_and_the_review_page_says_so(world):
    from apps.api.models import RequestUpload
    w = world()
    _complete(w)
    record = w.db.query(RequestUpload).filter_by(asset_id=w.asset.id).one()
    assert record.submitted_at is not None
    assert record.uploader_name == 'Mika'
    assert record.uploader_email == w.editor.email
    assert record.timing_provenance['provenance'] == 'unclassified', 'an adopted upload never claims natural timing'
    w.version.processing_status = w.version.processing_status.__class__.ready
    w.db.commit()
    review = w.rq._editor_review(w.db, w.db.query(w.rq.UploadRequest).filter_by(token=w.token).one())
    assert [a['review_state'] for a in review['assets']] == ['reviewing']
    assert review['gate']['status'] == 'reviewing'


def test_a_retried_complete_writes_one_row(world):
    from apps.api.models import RequestUpload
    w = world()
    _complete(w)
    first = w.db.query(RequestUpload).filter_by(asset_id=w.asset.id).one().submitted_at
    _complete(w)
    assert w.db.query(RequestUpload).filter_by(asset_id=w.asset.id).one().submitted_at == first


def test_a_plain_upload_in_a_folder_with_no_handin_writes_nothing(world):
    from apps.api.models import RequestUpload
    w = world(with_request=False)
    _complete(w)
    assert w.db.query(RequestUpload).filter_by(asset_id=w.asset.id).count() == 0
