"""The actual call sites: POST /upload/complete, POST /r/{token}/upload/complete,
POST /r/{token}/finish and POST /r/{token}/object all announce to the company-DB workflow-events
store. test_workflow_events.py covers the service's own logic in isolation; these pin that the
routers actually reach it, with a faked RPC sink standing in for db.aditor.ai.
"""
import json
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

from fastapi import BackgroundTasks

from apps.api.config import settings
from apps.api.models.asset import Asset, AssetVersion, MediaFile, ProcessingStatus
from apps.api.models.upload_request import UploadRequest


def _enable_workflow_events():
    settings.companydb_url = "https://db.aditor.ai"
    settings.companydb_workflow_jwt = "jwt-token"
    settings.frontend_url = "https://feedback.aditor.ai"


def _disable_workflow_events():
    settings.companydb_workflow_jwt = ""


def test_complete_upload_announces_handin_uploaded_for_a_linked_staff_handin(monkeypatch):
    monkeypatch.setattr('apps.api.routers.upload._record_handin_submission', lambda *a: None)
    import apps.api.routers.upload as upload_module
    from apps.api.services import workflow_events

    _enable_workflow_events()
    try:
        user_id = uuid.uuid4()
        asset_id = uuid.uuid4()
        version_id = uuid.uuid4()
        folder_id = uuid.uuid4()

        version = SimpleNamespace(id=version_id, asset_id=asset_id, created_by=user_id,
                                  version_number=1, processing_status=ProcessingStatus.uploading)
        media = SimpleNamespace(version_id=version_id, s3_key_raw="raw/key")
        asset = SimpleNamespace(id=asset_id, folder_id=folder_id, project_id=uuid.uuid4())
        req = SimpleNamespace(id=uuid.uuid4(), folder_id=folder_id, token="tok_abc123", brand_slug="brand-x",
                              last_uploader_email="editor@aditor.ai",
                              iteration_state={"internal_handin": {"card_url": "https://trello.com/c/abc12345"}})

        def fake_query(model):
            q = MagicMock()
            table = {AssetVersion: version, MediaFile: media, Asset: asset, UploadRequest: req}
            q.filter.return_value.first.return_value = table.get(model)
            return q

        db = MagicMock()
        db.query = MagicMock(side_effect=fake_query)
        db.get = MagicMock(side_effect=lambda model, _id: asset if model is Asset else None)

        monkeypatch.setattr(upload_module, "_campaign_upload_access", lambda db, version: None)
        monkeypatch.setattr(upload_module, "require_unmanaged", lambda asset: None)
        monkeypatch.setattr(upload_module, "complete_multipart_upload", lambda *a, **k: None)

        sent = []
        monkeypatch.setattr(workflow_events.httpx, "post",
                            lambda url, content=None, headers=None, timeout=None: sent.append(json.loads(content)["p"]) or MagicMock())

        body = upload_module.CompleteUploadRequest(
            s3_key="raw/key", upload_id="up1", asset_id=asset_id, version_id=version_id, parts=[],
        )
        current_user = SimpleNamespace(id=user_id)
        response = upload_module.complete_upload(body, BackgroundTasks(), db, current_user)

        assert response.status == "processing"
        assert len(sent) == 1
        assert sent[0]["action"] == "handin.uploaded"
        assert sent[0]["card_ref"] == "https://trello.com/c/abc12345"
        assert sent[0]["brand_slug"] == "brand-x"
        assert sent[0]["email"] == "editor@aditor.ai"
        assert sent[0]["props"] == {"version_no": 1, "version_id": str(version_id)}
    finally:
        _disable_workflow_events()


def test_guest_complete_announces_handin_uploaded_for_a_request_lane_handin(monkeypatch):
    import apps.api.routers.requests as requests_module
    from apps.api.services import workflow_events

    _enable_workflow_events()
    try:
        asset_id = uuid.uuid4()
        version_id = uuid.uuid4()
        folder_id = uuid.uuid4()
        version = SimpleNamespace(id=version_id, asset_id=asset_id, version_number=1,
                                  processing_status=ProcessingStatus.uploading)
        asset = SimpleNamespace(id=asset_id, folder_id=folder_id, project_id=uuid.uuid4(), name="boddy fixed.mp4")
        req = SimpleNamespace(id=uuid.uuid4(), folder_id=folder_id, completed_at=None, token="tok_xyz",
                              brand_slug="cust-0000000000000000", last_uploader_email="freelancer@example.com",
                              iteration_state={})

        def fake_query(model):
            q = MagicMock()
            q.filter.return_value.first.return_value = {UploadRequest: req}.get(model)
            q.filter.return_value.populate_existing.return_value.with_for_update.return_value.one.return_value = version
            return q

        db = MagicMock()
        db.query = MagicMock(side_effect=fake_query)
        db.get = MagicMock(side_effect=lambda model, _id: asset if model is Asset else None)

        monkeypatch.setattr(requests_module, "_live_request", lambda *a, **k: req)
        monkeypatch.setattr(requests_module, "locked_request", lambda *a: req)
        monkeypatch.setattr(requests_module, "_owned_media", lambda *a: (MagicMock(), version))
        monkeypatch.setattr(requests_module, "_record_uploader", lambda *a: None)
        monkeypatch.setattr(requests_module, "freeze_submission_timing", lambda *a: None)
        monkeypatch.setattr(requests_module, "complete_multipart_upload", lambda *a, **k: None)
        monkeypatch.setattr(requests_module, "components", lambda r: False)
        monkeypatch.setattr(requests_module.s3_service, "get_s3_client",
                            lambda: MagicMock(head_object=lambda **k: {"ContentLength": 1}))

        sent = []
        monkeypatch.setattr(workflow_events.httpx, "post",
                            lambda url, content=None, headers=None, timeout=None: sent.append(json.loads(content)["p"]) or MagicMock())

        body = requests_module.GuestComplete(s3_key="raw/key", upload_id="up1", parts=[])
        response = requests_module.guest_complete("tok", body, BackgroundTasks(), db)

        assert response["status"] == "processing"
        assert len(sent) == 1
        assert sent[0]["action"] == "handin.uploaded"
        assert sent[0]["card_ref"] == "https://feedback.aditor.ai/r/tok_xyz"
        assert sent[0]["email"] == "freelancer@example.com"
    finally:
        _disable_workflow_events()


def test_finish_request_announces_handin_finished(monkeypatch):
    import apps.api.routers.requests as requests_module
    from apps.api.services import workflow_events

    _enable_workflow_events()
    try:
        req = SimpleNamespace(id=uuid.uuid4(), completed_at=None, token="tok_done", brand_slug="brand-y",
                              last_uploader_email="editor@aditor.ai", completion_versions=None, iteration_state={})

        monkeypatch.setattr(requests_module, "_live_request", lambda *a, **k: req)
        monkeypatch.setattr(requests_module, "locked_request", lambda *a: req)
        monkeypatch.setattr(requests_module, "components", lambda r: False)
        monkeypatch.setattr(requests_module, "_editor_review", lambda db, r: {
            "assets": [{"asset_id": "a1", "version_id": "v1", "review_state": "clear"}],
            "gate": {"status": "clear", "open_must_fixes": 0},
        })

        sent = []
        monkeypatch.setattr(workflow_events.httpx, "post",
                            lambda url, content=None, headers=None, timeout=None: sent.append(json.loads(content)["p"]) or MagicMock())

        response = requests_module.finish_request("tok", MagicMock())

        assert response["completed_at"] == req.completed_at.isoformat()
        assert len(sent) == 1
        assert sent[0]["action"] == "handin.finished"
        assert sent[0]["brand_slug"] == "brand-y"
    finally:
        _disable_workflow_events()


def test_guest_object_announces_revision_responded(monkeypatch):
    import apps.api.routers.requests as requests_module
    from apps.api.services import workflow_events

    _enable_workflow_events()
    try:
        asset_id = uuid.uuid4()
        version_id = uuid.uuid4()
        folder_id = uuid.uuid4()
        asset = SimpleNamespace(id=asset_id, folder_id=folder_id, deleted_at=None)
        current = SimpleNamespace(id=version_id, version_number=2, processing_status=ProcessingStatus.ready)
        req = SimpleNamespace(id=uuid.uuid4(), folder_id=folder_id, token="tok_obj", brand_slug="brand-z",
                              last_uploader_email="editor@aditor.ai", last_uploader_name="Editor",
                              review_share_token="rtok", iteration_state={})

        def fake_query(model):
            q = MagicMock()
            table = {Asset: asset, AssetVersion: current}
            q.filter.return_value.first.return_value = table.get(model)
            q.filter.return_value.order_by.return_value.first.return_value = current
            return q

        db = MagicMock()
        db.query = MagicMock(side_effect=fake_query)

        monkeypatch.setattr(requests_module, "_live_request", lambda *a, **k: req)
        monkeypatch.setattr(requests_module, "locked_request", lambda *a: req)
        monkeypatch.setattr(requests_module, "components", lambda r: False)
        monkeypatch.setattr(requests_module.review_bridge, "object_to_note",
                            lambda *a, **k: {"withdrawn": False})

        sent = []
        monkeypatch.setattr(workflow_events.httpx, "post",
                            lambda url, content=None, headers=None, timeout=None: sent.append(json.loads(content)["p"]) or MagicMock())

        body = requests_module.GuestObjection(asset_id=asset_id, comment_id="", body="",
                                              text="this is correct, not a real issue")
        result = requests_module.guest_object("tok", body, db)

        assert result == {"withdrawn": False}
        assert len(sent) == 1
        assert sent[0]["action"] == "revision.responded"
        assert sent[0]["brand_slug"] == "brand-z"
        assert sent[0]["props"] == {"asset_id": str(asset_id)}
    finally:
        _disable_workflow_events()


def test_a_companydb_outage_never_fails_a_handin(monkeypatch):
    """Acceptance: emission is best-effort - a company-DB/RPC failure never fails or delays the
    hand-in it reports, even with workflow events enabled."""
    import apps.api.routers.requests as requests_module
    from apps.api.services import workflow_events

    _enable_workflow_events()
    try:
        asset_id = uuid.uuid4()
        version_id = uuid.uuid4()
        folder_id = uuid.uuid4()
        version = SimpleNamespace(id=version_id, asset_id=asset_id, version_number=1,
                                  processing_status=ProcessingStatus.uploading)
        asset = SimpleNamespace(id=asset_id, folder_id=folder_id, project_id=uuid.uuid4(), name="x.mp4")
        req = SimpleNamespace(id=uuid.uuid4(), folder_id=folder_id, completed_at=None, token="tok_xyz",
                              brand_slug="brand-x", last_uploader_email="editor@aditor.ai", iteration_state={})

        def fake_query(model):
            q = MagicMock()
            q.filter.return_value.first.return_value = {UploadRequest: req}.get(model)
            q.filter.return_value.populate_existing.return_value.with_for_update.return_value.one.return_value = version
            return q

        db = MagicMock()
        db.query = MagicMock(side_effect=fake_query)
        db.get = MagicMock(side_effect=lambda model, _id: asset if model is Asset else None)

        monkeypatch.setattr(requests_module, "_live_request", lambda *a, **k: req)
        monkeypatch.setattr(requests_module, "locked_request", lambda *a: req)
        monkeypatch.setattr(requests_module, "_owned_media", lambda *a: (MagicMock(), version))
        monkeypatch.setattr(requests_module, "_record_uploader", lambda *a: None)
        monkeypatch.setattr(requests_module, "freeze_submission_timing", lambda *a: None)
        monkeypatch.setattr(requests_module, "complete_multipart_upload", lambda *a, **k: None)
        monkeypatch.setattr(requests_module, "components", lambda r: False)
        monkeypatch.setattr(requests_module.s3_service, "get_s3_client",
                            lambda: MagicMock(head_object=lambda **k: {"ContentLength": 1}))

        def boom(*a, **k):
            raise RuntimeError("db.aditor.ai unreachable")
        monkeypatch.setattr(workflow_events.httpx, "post", boom)

        body = requests_module.GuestComplete(s3_key="raw/key", upload_id="up1", parts=[])
        response = requests_module.guest_complete("tok", body, BackgroundTasks(), db)  # must not raise

        assert response["status"] == "processing"
    finally:
        _disable_workflow_events()
