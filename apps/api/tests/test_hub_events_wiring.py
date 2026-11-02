"""The actual call sites: POST /upload/complete and POST /share/{token}/comment announce to the
hub. test_hub_events.py covers the service's own logic in isolation; these pin that the two
routers actually reach it, with a faked webhook sink standing in for the hub.
"""
import json
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

from fastapi import BackgroundTasks

from apps.api.config import settings
from apps.api.models.asset import Asset, AssetVersion, MediaFile, ProcessingStatus
from apps.api.models.project import Project
from apps.api.models.upload_request import UploadRequest
from apps.api.models.share import SharePermission


def test_complete_upload_announces_revision_submitted_for_a_handin(monkeypatch):
    monkeypatch.setattr('apps.api.routers.upload._record_handin_submission', lambda *a: None)
    import apps.api.routers.upload as upload_module
    from apps.api.services import hub_events

    settings.hub_events_webhook_url = "https://hub.aditor.ai/api/revision/freeframe-webhook"
    try:
        user_id = uuid.uuid4()
        asset_id = uuid.uuid4()
        version_id = uuid.uuid4()
        folder_id = uuid.uuid4()

        version = SimpleNamespace(id=version_id, asset_id=asset_id, created_by=user_id,
                                  processing_status=ProcessingStatus.uploading)
        media = SimpleNamespace(version_id=version_id, s3_key_raw="raw/key")
        asset = SimpleNamespace(id=asset_id, folder_id=folder_id, project_id=uuid.uuid4())
        req = SimpleNamespace(folder_id=folder_id, last_uploader_email="editor@aditor.ai",
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

        sent = {}
        monkeypatch.setattr(hub_events.httpx, "post",
                            lambda url, content=None, headers=None, timeout=None: sent.update(json.loads(content)) or MagicMock())

        body = upload_module.CompleteUploadRequest(
            s3_key="raw/key", upload_id="up1", asset_id=asset_id, version_id=version_id, parts=[],
        )
        current_user = SimpleNamespace(id=user_id)
        response = upload_module.complete_upload(body, BackgroundTasks(), db, current_user)

        assert response.status == "processing"
        assert sent == {
            "event": "revision_submitted",
            "card_url": "https://trello.com/c/abc12345",
            "editor_email": "editor@aditor.ai",
            "version_id": str(version_id),
        }
    finally:
        settings.hub_events_webhook_url = ""


def test_complete_upload_announces_revision_submitted_for_a_plain_upload(monkeypatch):
    """Delivery path must not matter: an ordinary (non hand-in) upload still announces, keyed on the
    asset page so the hub resolves the client revisions on that asset."""
    import apps.api.routers.upload as upload_module
    from apps.api.services import hub_events

    settings.hub_events_webhook_url = "https://hub.aditor.ai/api/revision/freeframe-webhook"
    settings.frontend_url = "https://feedback.aditor.ai"
    try:
        user_id = uuid.uuid4()
        asset_id = uuid.uuid4()
        version_id = uuid.uuid4()
        project_id = uuid.uuid4()

        version = SimpleNamespace(id=version_id, asset_id=asset_id, created_by=user_id,
                                  processing_status=ProcessingStatus.uploading)
        media = SimpleNamespace(version_id=version_id, s3_key_raw="raw/key")
        asset = SimpleNamespace(id=asset_id, folder_id=None, project_id=project_id, name="hook3.mp4", created_by=user_id)

        def fake_query(model):
            q = MagicMock()
            table = {AssetVersion: version, MediaFile: media, Asset: asset, UploadRequest: None}
            q.filter.return_value.first.return_value = table.get(model)
            return q

        def fake_get(model, _id):
            name = getattr(model, "__name__", "")
            if model is Asset:
                return asset
            if name == "AssetVersion":
                return SimpleNamespace(created_by=user_id)
            if name == "User":
                return SimpleNamespace(email="luk@aditor.ai")
            if name == "Project":
                return SimpleNamespace(name="AgelessRx")
            return None

        db = MagicMock()
        db.query = MagicMock(side_effect=fake_query)
        db.get = MagicMock(side_effect=fake_get)

        monkeypatch.setattr(upload_module, "_campaign_upload_access", lambda db, version: None)
        monkeypatch.setattr(upload_module, "require_unmanaged", lambda asset: None)
        monkeypatch.setattr(upload_module, "complete_multipart_upload", lambda *a, **k: None)

        sent = {}
        monkeypatch.setattr(hub_events.httpx, "post",
                            lambda url, content=None, headers=None, timeout=None: sent.update(json.loads(content)) or MagicMock())

        body = upload_module.CompleteUploadRequest(
            s3_key="raw/key", upload_id="up1", asset_id=asset_id, version_id=version_id, parts=[],
        )
        current_user = SimpleNamespace(id=user_id)
        response = upload_module.complete_upload(body, BackgroundTasks(), db, current_user)

        page = f"https://feedback.aditor.ai/projects/{project_id}/assets/{asset_id}"
        assert response.status == "processing"
        assert sent == {
            "event": "revision_submitted",
            "card_url": page,
            "editor_email": "luk@aditor.ai",
            "version_id": str(version_id),
        }
    finally:
        settings.hub_events_webhook_url = ""


def test_guest_comment_on_a_handin_version_announces_client_comment(monkeypatch):
    import apps.api.routers.comments as comments_module
    from apps.api.services import hub_events

    settings.hub_events_webhook_url = "https://hub.aditor.ai/api/revision/freeframe-webhook"
    settings.frontend_url = "https://feedback.aditor.ai"
    try:
        folder_id = uuid.uuid4()
        asset_id = uuid.uuid4()
        version_id = uuid.uuid4()
        project_id = uuid.uuid4()

        link = SimpleNamespace(id=uuid.uuid4(), asset_id=asset_id, permission=SharePermission.comment)
        asset = SimpleNamespace(id=asset_id, folder_id=folder_id, name="cut.mp4", project_id=project_id)
        req = SimpleNamespace(folder_id=folder_id, last_uploader_email="editor@aditor.ai", token="rtok123",
                              iteration_state={"internal_handin": {"card_url": "https://feedback.aditor.ai/review/abc12345"}})

        monkeypatch.setattr(comments_module, "validate_share_link_with_session", lambda *a, **k: link)
        monkeypatch.setattr(comments_module, "_get_asset", lambda db, asset_id_: asset)
        monkeypatch.setattr(comments_module, "validate_asset_in_share", lambda *a, **k: None)
        monkeypatch.setattr(comments_module, "validate_comment_version", lambda *a, **k: None)
        monkeypatch.setattr(comments_module, "_build_comment_response", lambda comment, db: {"id": str(comment.id)})

        existing_guest = SimpleNamespace(id=uuid.uuid4(), email="client@brand.com", name="A Client")

        def fake_query(model):
            q = MagicMock()
            if model is UploadRequest:
                q.filter.return_value.first.return_value = req
            elif model is comments_module.GuestUser:
                # An existing guest, so the code takes the "seen before" branch rather than
                # constructing a new GuestUser whose id would only be assigned by a real flush.
                q.filter.return_value.first.return_value = existing_guest
            else:
                q.filter.return_value.first.return_value = None
            return q

        db = MagicMock()
        db.query = MagicMock(side_effect=fake_query)
        db.get = MagicMock(side_effect=lambda model, _id: SimpleNamespace(name="AgelessRx") if getattr(model, "__name__", "") == "Project" else None)

        sent = {}
        monkeypatch.setattr(hub_events.httpx, "post",
                            lambda url, content=None, headers=None, timeout=None: sent.update(json.loads(content)) or MagicMock())

        from apps.api.schemas.comment import GuestCommentCreate
        body = GuestCommentCreate(version_id=version_id, body="Make the logo bigger",
                                  guest_email="client@brand.com", guest_name="A Client")
        comments_module.guest_comment(token="tok", body=body, share_session=None, db=db,
                                      current_user=None, authorization=None)

        assert sent == {
            "event": "client_comment",
            "card_url": "https://feedback.aditor.ai/review/abc12345",
            "editor_email": "editor@aditor.ai",
            "comment_id": sent["comment_id"],
            "comment_body": "Make the logo bigger",
            "author_name": "A Client",
            "version_id": str(version_id),
            "review_url": "https://feedback.aditor.ai/r/rtok123",
            "client": "AgelessRx",
            "title": "cut.mp4",
        }
    finally:
        settings.hub_events_webhook_url = ""


def test_create_comment_from_a_logged_in_client_announces_client_comment(monkeypatch):
    """The authenticated in-app path: a logged-in customer (is_staff=False) posting to
    /assets/{id}/comments routes to the version's uploader, just like a share-link guest comment.
    A staff member's comment on the same route must stay silent (covered at the service level)."""
    import apps.api.routers.comments as comments_module
    from apps.api.services import hub_events

    settings.hub_events_webhook_url = "https://hub.aditor.ai/api/revision/freeframe-webhook"
    settings.frontend_url = "https://feedback.aditor.ai"
    try:
        client_id = uuid.uuid4()
        uploader_id = uuid.uuid4()
        asset_id = uuid.uuid4()
        version_id = uuid.uuid4()
        project_id = uuid.uuid4()

        asset = SimpleNamespace(id=asset_id, folder_id=None, project_id=project_id,
                                name="hook3.mp4", created_by=uploader_id)
        version = SimpleNamespace(id=version_id, asset_id=asset_id, created_by=uploader_id)

        def fake_query(model):
            q = MagicMock()
            if model is AssetVersion:
                q.filter.return_value.first.return_value = version
            elif model is UploadRequest:
                q.filter.return_value.first.return_value = None
            else:
                q.filter.return_value.first.return_value = None
            return q

        def fake_get(model, pk):
            name = getattr(model, "__name__", str(model))
            if name == "AssetVersion":
                return version
            if name == "User":
                if pk == client_id:
                    return SimpleNamespace(email="brand@customer.com", is_staff=False)
                return SimpleNamespace(email="luk@aditor.ai", is_staff=True)
            if name == "Project":
                return SimpleNamespace(name="AgelessRx")
            return None

        db = MagicMock()
        db.query = MagicMock(side_effect=fake_query)
        db.get = MagicMock(side_effect=fake_get)

        monkeypatch.setattr(comments_module, "_get_asset", lambda db_, aid: asset)
        monkeypatch.setattr(comments_module, "require_asset_access", lambda *a, **k: None)
        monkeypatch.setattr(comments_module, "_create_mentions", lambda *a, **k: None)
        monkeypatch.setattr(comments_module, "_build_comment_response", lambda *a, **k: {"ok": True})
        monkeypatch.setattr(comments_module.brand_loop, "queue_comment", lambda *a, **k: None)

        sent = {}
        monkeypatch.setattr(hub_events.httpx, "post",
                            lambda url, content=None, headers=None, timeout=None: sent.update(json.loads(content)) or MagicMock())

        from apps.api.schemas.comment import CommentCreate
        body = CommentCreate(version_id=version_id, body="please cut the intro")
        current_user = SimpleNamespace(id=client_id, name="Brand Owner", email="brand@customer.com")
        comments_module.create_comment(asset_id, body, db, current_user, BackgroundTasks())

        page = f"https://feedback.aditor.ai/projects/{project_id}/assets/{asset_id}"
        assert sent["event"] == "client_comment"
        assert sent["card_url"] == page
        assert sent["editor_email"] == "luk@aditor.ai"
        assert sent["comment_body"] == "please cut the intro"
        assert sent["author_name"] == "Brand Owner"
        assert sent["client"] == "AgelessRx"
        assert sent["title"] == "hook3.mp4"
    finally:
        settings.hub_events_webhook_url = ""


def test_guest_comment_from_the_automation_reviewer_announces_nothing(monkeypatch):
    """The craft reviewer posts as a guest too, but its comments are stored visibility="internal" -
    never a client ask, so the webhook must stay silent even though guest_author_id is set."""
    import apps.api.routers.comments as comments_module
    from apps.api.services import hub_events

    settings.hub_events_webhook_url = "https://example.invalid/hook"
    original_automation_guest_emails = settings.automation_guest_emails
    settings.automation_guest_emails = "review@aditor.ai"
    try:
        folder_id = uuid.uuid4()
        asset_id = uuid.uuid4()
        version_id = uuid.uuid4()

        link = SimpleNamespace(id=uuid.uuid4(), asset_id=asset_id, permission=SharePermission.comment)
        asset = SimpleNamespace(id=asset_id, folder_id=folder_id, name="cut.mp4")

        monkeypatch.setattr(comments_module, "validate_share_link_with_session", lambda *a, **k: link)
        monkeypatch.setattr(comments_module, "_get_asset", lambda db, asset_id_: asset)
        monkeypatch.setattr(comments_module, "validate_asset_in_share", lambda *a, **k: None)
        monkeypatch.setattr(comments_module, "validate_comment_version", lambda *a, **k: None)
        monkeypatch.setattr(comments_module, "_build_comment_response", lambda comment, db: {"id": str(comment.id)})

        db = MagicMock()
        db.query.return_value.filter.return_value.first.return_value = None

        post = MagicMock()
        monkeypatch.setattr(hub_events.httpx, "post", post)

        from apps.api.schemas.comment import GuestCommentCreate
        body = GuestCommentCreate(version_id=version_id, body="Must fix - color is off",
                                  guest_email="review@aditor.ai", guest_name="Auto Review")
        comments_module.guest_comment(token="tok", body=body, share_session=None, db=db,
                                      current_user=None, authorization=None)

        post.assert_not_called()
    finally:
        settings.hub_events_webhook_url = ""
        settings.automation_guest_emails = original_automation_guest_emails


def test_guest_complete_announces_revision_submitted_for_a_split_handin(monkeypatch):
    """The editor's /r/<token> upload (Split upload parts, the fix for an assembled ad) is a
    revision answer too: it must reach the hub with the hand-in's Trello card_url, otherwise the
    open client revisions on that card stay open and escalate to a Trust deduction."""
    import apps.api.routers.requests as requests_module
    from apps.api.services import hub_events

    settings.hub_events_webhook_url = "https://hub.aditor.ai/api/revision/freeframe-webhook"
    try:
        asset_id = uuid.uuid4()
        version_id = uuid.uuid4()
        folder_id = uuid.uuid4()
        version = SimpleNamespace(id=version_id, asset_id=asset_id, processing_status=ProcessingStatus.uploading)
        asset = SimpleNamespace(id=asset_id, folder_id=folder_id, project_id=uuid.uuid4(), name="boddy fixed.mp4")
        req = SimpleNamespace(id=uuid.uuid4(), folder_id=folder_id, completed_at=None,
                              last_uploader_email="editor@aditor.ai",
                              iteration_state={"internal_handin": {"card_url": "https://trello.com/c/abc12345"}})

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

        sent = {}
        monkeypatch.setattr(hub_events.httpx, "post",
                            lambda url, content=None, headers=None, timeout=None: sent.update(json.loads(content)) or MagicMock())

        body = requests_module.GuestComplete(s3_key="raw/key", upload_id="up1", parts=[])
        response = requests_module.guest_complete("tok", body, BackgroundTasks(), db)

        assert response["status"] == "processing"
        assert sent == {
            "event": "revision_submitted",
            "card_url": "https://trello.com/c/abc12345",
            "editor_email": "editor@aditor.ai",
            "version_id": str(version_id),
        }
    finally:
        settings.hub_events_webhook_url = ""
