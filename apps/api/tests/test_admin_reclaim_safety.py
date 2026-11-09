"""Isolated reclaim contracts; destructive SQL coverage lives in test_admin_panel_storage."""
import logging
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from apps.api.config import settings
from apps.api.models.asset import AssetVersion, MediaFile, ProcessingStatus
from apps.api.models.branding import ProjectBranding
from apps.api.models.project import Project
from apps.api.services import admin_panel, restore_rules
from apps.api.tasks import cleanup_tasks as ct


def _rows(db, model, *, first=None, rows=()):
    query = MagicMock()
    query.filter.return_value = query
    query.first.return_value = first
    query.all.return_value = list(rows)
    return query


def _cascade_db(project=None, branding=None, version=None, media=()):
    db = MagicMock()
    queries = {
        Project: _rows(db, Project, first=project),
        ProjectBranding: _rows(db, ProjectBranding, first=branding),
        AssetVersion: _rows(db, AssetVersion, first=version),
        MediaFile: _rows(db, MediaFile, rows=media),
    }
    empty = _rows(db, None)
    db.query.side_effect = lambda model: queries.get(model, empty)
    return db


@pytest.mark.parametrize('deferred', [False, True])
@pytest.mark.parametrize('owned', [False, True])
def test_project_artwork_uses_the_reclaim_path(monkeypatch, s3, deferred, owned):
    project = Project(id=uuid.uuid4(), poster_s3_key='posters/synthetic.jpg')
    logo = f'branding/{project.id}/logo/synthetic.png' if owned else 'raw/another-file'
    db = _cascade_db(project=project, branding=SimpleNamespace(logo_s3_key=logo))
    counts = ct.PurgeCounts(deferred=[] if deferred else None)
    ct._purge_project(db, project.id, counts)
    expected = {project.poster_s3_key} | ({logo} if owned else set())
    if deferred:
        assert s3['delete_object'] == []
        ct.run_deferred(counts)
    assert set(s3['delete_object']) == expected
    assert counts.s3_deletes == len(expected)
    assert counts.s3_failures == 0


def test_failed_project_artwork_deletes_are_not_reported_as_success(monkeypatch, s3):
    project = Project(id=uuid.uuid4(), poster_s3_key='posters/synthetic.jpg')
    db = _cascade_db(project=project, branding=SimpleNamespace(logo_s3_key=f'branding/{project.id}/logo/synthetic.png'))

    def refuse(key):
        raise RuntimeError('synthetic store unavailable')

    monkeypatch.setattr(ct, 'delete_object', refuse)
    counts = ct.PurgeCounts()
    ct._purge_project(db, project.id, counts)
    assert (counts.s3_deletes, counts.s3_failures) == (0, 2)


@pytest.mark.parametrize('status', [ProcessingStatus.ready, ProcessingStatus.uploading])
def test_only_open_uploads_send_abort_and_abort_is_not_an_object_delete(s3, status):
    version = AssetVersion(id=uuid.uuid4(), upload_id='synthetic', processing_status=status)
    media = MediaFile(s3_key_raw='raw/synthetic')
    db = _cascade_db(version=version, media=[media])
    counts = ct.PurgeCounts(deferred=[])
    ct._purge_version(db, version.id, counts)
    assert s3['abort'] == [], 'all store calls wait for the commit'
    ct.run_deferred(counts)
    assert s3['abort'] == (['raw/synthetic'] if status == ProcessingStatus.uploading else [])
    assert (counts.s3_deletes, counts.s3_failures) == (1, 0)


@pytest.mark.parametrize('code', ['NoSuchUpload', 'NoSuchKey', '404', 'NotFound'])
def test_gone_aborts_are_noops_but_other_failures_are_reported(monkeypatch, code):
    def gone(*args):
        raise ClientError({'Error': {'Code': code}}, 'AbortMultipartUpload')

    monkeypatch.setattr(ct, 'abort_multipart_upload', gone)
    counts = ct.PurgeCounts()
    ct._run_reclaim(counts, 'abort', ('raw/synthetic', 'synthetic'))
    assert (counts.s3_deletes, counts.s3_failures) == (0, 0)


def test_an_abort_refused_by_the_store_is_reported(monkeypatch):
    def refused(*args):
        raise ClientError({'Error': {'Code': 'AccessDenied'}}, 'AbortMultipartUpload')

    monkeypatch.setattr(ct, 'abort_multipart_upload', refused)
    counts = ct.PurgeCounts()
    ct._run_reclaim(counts, 'abort', ('raw/synthetic', 'synthetic'))
    assert (counts.s3_deletes, counts.s3_failures) == (0, 1)


@pytest.mark.parametrize('master', [None, 0, 1000])
def test_failed_restore_checks_the_master_before_clearing_deleted_at(monkeypatch, master):
    version = AssetVersion(id=uuid.uuid4(), processing_status=ProcessingStatus.failed, deleted_at=datetime.now(timezone.utc))
    query = MagicMock()
    query.filter.return_value = query
    query.first.return_value = version
    query.update.return_value = 1
    db = MagicMock()
    db.query.return_value = query
    holds = MagicMock(return_value=master is not None)
    monkeypatch.setattr(ct, '_holds_a_master', holds)
    assert restore_rules.restore_version_row(db, version.id) == (master is not None)
    holds.assert_called_once_with(db, version)
    assert query.update.call_count == int(master is not None)


@pytest.mark.parametrize('failure', ['payload', 'commit'])
def test_audit_amend_failure_cannot_hide_a_completed_reclaim(monkeypatch, caplog, failure):
    counts = ct.PurgeCounts(projects=1, s3_deletes=2)
    audit = MagicMock()
    if failure == 'payload':
        from unittest.mock import PropertyMock
        type(audit).payload = PropertyMock(side_effect=RuntimeError('synthetic read failure'))
    else:
        audit.payload = {'s3_queued': 2}
    db = MagicMock()

    def commit():
        assert any('admin trash purge by user' in r.message for r in caplog.records)
        raise RuntimeError('synthetic amend failure')

    db.commit.side_effect = commit
    pending = {'_counts': counts, '_audit': audit, '_actor_id': uuid.uuid4(), 'freed_bytes': 1000}
    with caplog.at_level(logging.WARNING):
        result = admin_panel.reclaim_objects(db, pending)
    assert (result['s3_deletes'], result['s3_failures']) == (2, 0)
    db.rollback.assert_called_once()
    assert caplog.records[0].message.startswith('admin trash purge by user')


@pytest.mark.parametrize('status', [ProcessingStatus.failed, ProcessingStatus.uploading])
def test_latest_version_falls_back_when_no_version_is_viewable(status):
    asset_id, version_id = uuid.uuid4(), uuid.uuid4()
    query = MagicMock()
    query.filter.return_value = query
    query.all.side_effect = [[], [(asset_id, version_id, 1)]]
    db = MagicMock()
    db.query.return_value = query
    assert admin_panel.latest_version_ids(db, [asset_id]) == {asset_id: version_id}


def test_project_restore_clamps_an_absurd_retention_setting(monkeypatch, mock_db):
    from apps.api.routers.projects import restore_project

    # This contract isolates retention; authenticated authorization is exercised
    # against Postgres by test_superadmin_access.
    monkeypatch.setattr('apps.api.routers.projects.require_project_role', lambda *args, **kwargs: None)
    project = Project(id=uuid.uuid4(), deleted_at=datetime.now(timezone.utc))
    mock_db.first.return_value = project
    mock_db.update.return_value = 1
    monkeypatch.setattr(settings, 'soft_delete_retention_days', 10**15)
    assert restore_project(project.id, db=mock_db, current_user=SimpleNamespace(id=uuid.uuid4(), is_superadmin=True)) == {'ok': True}


@pytest.mark.parametrize(
    ('status', 'deleted', 'age_hours', 'upload_timeout', 'processing_timeout', 'expected'),
    [
        (ProcessingStatus.uploading, False, 1, 24, 6, True),
        (ProcessingStatus.uploading, True, 1, 24, 6, False),
        (ProcessingStatus.uploading, False, 25, 24, 6, False),
        (ProcessingStatus.uploading, False, 1000, 0, 6, True),
        (ProcessingStatus.uploading, False, 1000, -1, 6, True),
        (ProcessingStatus.processing, False, 1, 24, 6, True),
        (ProcessingStatus.processing, True, 1, 24, 6, True),
        (ProcessingStatus.processing, True, 7, 24, 6, False),
        (ProcessingStatus.processing, True, 1000, 24, 0, True),
    ],
)
def test_purge_protects_active_jobs_but_not_abandoned_work(
    monkeypatch, status, deleted, age_hours, upload_timeout, processing_timeout, expected,
):
    now = datetime.now(timezone.utc)
    version = AssetVersion(
        id=uuid.uuid4(), version_number=1, processing_status=status,
        deleted_at=now if deleted else None,
        created_at=now - timedelta(hours=2000),
        last_activity_at=now - timedelta(hours=age_hours),
    )
    monkeypatch.setattr(settings, 'stale_upload_timeout_hours', upload_timeout)
    monkeypatch.setattr(settings, 'stuck_processing_timeout_hours', processing_timeout)
    db = MagicMock()

    def query(*columns):
        result = MagicMock()
        result.join.return_value = result

        def filtered(*criteria):
            # Evaluate the status predicate the service supplies, so the former
            # processing-only query cannot pass the active-upload case.
            statuses = criteria[-1].right.value
            statuses = statuses if isinstance(statuses, (list, tuple)) else [statuses]
            row = ('Synthetic clip', version if columns[1] is AssetVersion else 1)
            result.all.return_value = [row] if status in statuses else []
            return result

        result.filter.side_effect = filtered
        return result

    db.query.side_effect = query
    result = admin_panel._still_being_written(db, [], [uuid.uuid4()], [])
    assert result == (['Synthetic clip version 1'] if expected else [])
