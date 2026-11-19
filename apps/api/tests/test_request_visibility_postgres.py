"""Real SQL and HTTP checks for recoverable assignment deletion; no provider calls."""
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

pytestmark = pytest.mark.skipif(
    not os.getenv('ITERATIONS_TEST_DATABASE_URL'), reason='opt-in local PostgreSQL check')


@pytest.fixture
def workspace(monkeypatch):
    from apps.api.database import Base, get_db
    from apps.api.middleware.auth import get_current_user, get_optional_user
    from apps.api.models import User, Project, Folder, UploadRequest, Asset, AssetVersion, RequestUpload, MediaFile, ShareLink
    from apps.api.models.asset import AssetType, ProcessingStatus, FileType
    from apps.api.models.comment import Comment
    from apps.api.models.project import ProjectMember, ProjectRole
    from apps.api.routers import requests, folders, share, comments

    admin = create_engine(os.environ['ITERATIONS_TEST_DATABASE_URL'])
    schema = 'request_visibility_' + uuid.uuid4().hex
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA {schema}'))
    engine = create_engine(os.environ['ITERATIONS_TEST_DATABASE_URL'],
                           connect_args={'options': f'-csearch_path={schema}'})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    try:
        with Session() as db:
            owner = User(email='owner@example.test', name='Customer owner', is_staff=False)
            db.add(owner); db.flush()
            project = Project(name='Active customer brand', created_by=owner.id, is_workspace=True)
            db.add(project); db.flush()
            db.add(ProjectMember(project_id=project.id, user_id=owner.id, role=ProjectRole.owner))
            target = Folder(name='Disposable assignment', project_id=project.id, created_by=owner.id)
            active = Folder(name='Active delivery', project_id=project.id, created_by=owner.id)
            db.add_all([target, active]); db.flush()
            request = UploadRequest(token='target-editor', review_share_token='target-customer',
                title=target.name, project_id=project.id, folder_id=target.id, created_by=owner.id)
            kept = UploadRequest(token='active-editor', review_share_token='active-customer',
                title=active.name, project_id=project.id, folder_id=active.id, created_by=owner.id)
            db.add_all([request, kept]); db.flush()
            asset = Asset(name='Delivered video', asset_type=AssetType.video, project_id=project.id,
                          folder_id=active.id, created_by=owner.id)
            db.add(asset); db.flush()
            version = AssetVersion(asset_id=asset.id, version_number=1,
                processing_status=ProcessingStatus.ready, created_by=owner.id)
            db.add(version); db.flush()
            db.add(RequestUpload(request_id=kept.id, asset_id=asset.id, version_number=1,
                submitted_at=datetime.now(timezone.utc), uploader_name='Editor', uploader_email='editor@example.test'))
            db.add(MediaFile(version_id=version.id, file_type=FileType.video, original_filename='cut.mp4',
                mime_type='video/mp4', file_size_bytes=100, s3_key_raw='synthetic/cut.mp4'))
            from apps.api.models.delivery import Delivery  # approved: the download gate lets it through
            db.add(Delivery(token='delivered-1', request_id=kept.id, asset_id=asset.id, version_id=version.id,
                            approved_by='Customer owner'))
            db.add(Comment(asset_id=asset.id, version_id=version.id, author_id=owner.id,
                           body='Customer feedback', visibility='public'))
            db.add_all([
                ShareLink(token='target-customer', folder_id=target.id, created_by=owner.id, allow_download=True),
                ShareLink(token='active-customer', folder_id=active.id, created_by=owner.id, allow_download=True),
                ShareLink(token='asset-customer', asset_id=asset.id, created_by=owner.id, allow_download=True),
                ShareLink(token='project-customer', project_id=project.id, created_by=owner.id, allow_download=True),
            ])
            db.commit()
            # Only external review/storage/rate services are replaced; all query and scope logic is real.
            monkeypatch.setattr(requests.review_bridge, 'request_status', lambda tokens: {
                token: {'status': 'clear', 'openMustFixes': 0} for token in tokens})
            monkeypatch.setattr(requests.review_bridge, 'asset_stats', lambda *a: {
                str(asset.id): {'version_id': str(version.id), 'reviewed': True, 'openMustFix': 0}})
            monkeypatch.setattr(share, 'generate_presigned_get_url', lambda key, **kw: 'https://media.example.test/' + key)
            monkeypatch.setattr('apps.api.middleware.rate_limit.check_rate_limit', lambda *a: (True, 0))
            app = FastAPI()
            for router in (requests.router, folders.router, share.router, comments.router):
                app.include_router(router)
            app.dependency_overrides[get_db] = lambda: db
            app.dependency_overrides[get_current_user] = lambda: owner
            app.dependency_overrides[get_optional_user] = lambda: None
            with TestClient(app) as client:
                yield dict(db=db, client=client, project=project, target=target, active=active,
                           request=request, kept=kept, asset=asset)
    finally:
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA {schema} CASCADE'))
        admin.dispose()


@pytest.mark.parametrize('project_scoped', [False, True])
def test_deleted_folder_request_disappears_and_restore_preserves_active_delivery(workspace, project_scoped):
    w = workspace
    params = {'project_id': str(w['project'].id)} if project_scoped else {}
    listing = lambda: w['client'].get('/requests', params=params).json()
    before = {r['id']: r for r in listing()}
    assert set(before) == {str(w['request'].id), str(w['kept'].id)}
    assert before[str(w['kept'].id)]['status'] == 'clear'
    assert before[str(w['kept'].id)]['assets'] == 1
    assert w['client'].delete(f"/folders/{w['target'].id}").status_code == 204
    assert listing() == [before[str(w['kept'].id)]]
    assert w['client'].get('/r/target-editor').status_code == 410
    assert w['client'].post(f"/folders/{w['target'].id}/restore").status_code == 200
    assert {r['id']: r for r in listing()} == before
    assert w['client'].get('/r/target-editor').status_code == 200


def test_deleted_folders_do_not_consume_the_visible_request_limit(workspace):
    from apps.api.models import Folder, UploadRequest
    w = workspace
    deleted = Folder(name='Deleted history', project_id=w['project'].id, created_by=w['request'].created_by,
                     deleted_at=datetime.now(timezone.utc))
    w['db'].add(deleted); w['db'].flush()
    for number in range(100):
        w['db'].add(UploadRequest(token=f'old-{number}', review_share_token=f'old-share-{number}',
            title='Deleted request', project_id=w['project'].id, folder_id=deleted.id,
            created_by=w['request'].created_by, created_at=datetime.now(timezone.utc) + timedelta(seconds=number + 1)))
    w['db'].commit()
    rows = w['client'].get('/requests').json()
    assert {r['id'] for r in rows} == {str(w['request'].id), str(w['kept'].id)}


@pytest.mark.parametrize('token', ['active-customer', 'asset-customer', 'project-customer'])
def test_deleted_project_share_hides_metadata_comments_and_download_until_restored(workspace, token):
    w = workspace
    paths = [f'/share/{token}', f'/share/{token}/comments?asset_id={w["asset"].id}',
             f'/share/{token}/stream/{w["asset"].id}?download=true']
    before = [w['client'].get(path) for path in paths]
    assert [r.status_code for r in before] == [200, 200, 200]
    assert before[1].json()[0]['body'] == 'Customer feedback'
    assert before[2].json()['url'] == 'https://media.example.test/synthetic/cut.mp4'
    w['project'].deleted_at = datetime.now(timezone.utc); w['db'].commit()
    after = [w['client'].get(path) for path in paths]
    assert [r.status_code for r in after] == [404, 404, 404]
    for response in after:
        assert 'Customer feedback' not in response.text and 'synthetic/cut.mp4' not in response.text
    w['project'].deleted_at = None; w['db'].commit()
    assert [w['client'].get(path).json() for path in paths] == [r.json() for r in before]


@pytest.mark.parametrize('folder_name,token,other', [
    ('target', 'target-customer', 'active-customer'),
    ('active', 'active-customer', 'target-customer'),
])
def test_deleted_folder_customer_share_closes_and_restore_keeps_token(workspace, folder_name, token, other):
    w = workspace
    before = w['client'].get(f'/share/{token}')
    assert before.status_code == 200
    assert w['client'].delete(f"/folders/{w[folder_name].id}").status_code == 204
    assert w['client'].get(f'/share/{token}').status_code == 404
    assert w['client'].get(f'/share/{other}').status_code == 200
    assert w['client'].post(f"/folders/{w[folder_name].id}/restore").status_code == 200
    assert w['client'].get(f'/share/{token}').json() == before.json()
