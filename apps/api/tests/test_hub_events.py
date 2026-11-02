"""Outbound hub events: a guest (client) comment routes to the responsible editor for ANY asset, and
a completed version resolves the open revisions on that asset. Service-level, mock-driven, like
test_folder_handins.py's style for automation_share.
"""
import hashlib
import hmac
import json
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

from apps.api.config import settings

FRONTEND = "https://feedback.aditor.ai"


def _handin_request(card_url="https://feedback.aditor.ai/review/abc12345", folder_id=None, editor_email="editor@aditor.ai"):
    return SimpleNamespace(
        folder_id=folder_id or uuid.uuid4(),
        iteration_state={"internal_handin": {"card_url": card_url, "editor_name": "Editor"}},
        last_uploader_email=editor_email,
    )


def _db_with_request(req):
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = req
    return db


def _db_non_handin(editor_email="luk@aditor.ai", project_name="AgelessRx"):
    """A db with no hand-in request, resolving AssetVersion -> User -> email and Project -> name via
    db.get (dispatched by model name, matching hub_events' lazy imports)."""
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    uploader_id = uuid.uuid4()

    def fake_get(model, pk):
        name = getattr(model, "__name__", str(model))
        if name == "AssetVersion":
            return SimpleNamespace(created_by=uploader_id) if pk is not None else None
        if name == "User":
            return SimpleNamespace(email=editor_email) if pk is not None else None
        if name == "Project":
            return SimpleNamespace(name=project_name) if pk is not None else None
        return None

    db.get.side_effect = fake_get
    return db


def test_webhook_is_off_by_default():
    from apps.api.services import hub_events
    settings.hub_events_webhook_url = ""
    assert hub_events.is_enabled() is False
    hub_events.announce_client_comment(MagicMock(), MagicMock(), MagicMock(), "A Client")
    hub_events.announce_revision_submitted(MagicMock(), MagicMock(), uuid.uuid4())  # must not raise


def test_a_guest_comment_on_a_handin_version_posts_a_signed_flat_client_comment_event(monkeypatch):
    from apps.api.services import hub_events
    settings.hub_events_webhook_url = "https://hub.aditor.ai/api/revision/freeframe-webhook"
    settings.hub_events_webhook_secret = "s3cret"
    try:
        folder_id = uuid.uuid4()
        req = _handin_request(folder_id=folder_id)
        db = _db_with_request(req)
        asset = SimpleNamespace(folder_id=folder_id)  # no project_id/name -> no asset-page fallback, no enrichment
        version_id = uuid.uuid4()
        comment = SimpleNamespace(id=uuid.uuid4(), body="Make the logo bigger", guest_author_id=uuid.uuid4(),
                                  visibility="public", version_id=version_id)

        sent = {}

        def fake_post(url, content=None, headers=None, timeout=None):
            sent["url"] = url
            sent["content"] = content
            sent["headers"] = headers
            return MagicMock(status_code=200)

        monkeypatch.setattr(hub_events.httpx, "post", fake_post)
        hub_events.announce_client_comment(db, comment, asset, "A Client")

        assert sent["url"] == "https://hub.aditor.ai/api/revision/freeframe-webhook"
        payload = json.loads(sent["content"])
        assert payload == {
            "event": "client_comment",
            "card_url": "https://feedback.aditor.ai/review/abc12345",
            "editor_email": "editor@aditor.ai",
            "comment_id": str(comment.id),
            "comment_body": "Make the logo bigger",
            "author_name": "A Client",
            "version_id": str(version_id),
        }
        expected_sig = hmac.new(b"s3cret", sent["content"], hashlib.sha256).hexdigest()
        assert sent["headers"]["X-Aditor-Signature"] == expected_sig
    finally:
        settings.hub_events_webhook_url = ""
        settings.hub_events_webhook_secret = ""


def test_a_guest_comment_outside_any_handin_still_routes_to_the_asset_editor(monkeypatch):
    """The fix: delivery path must not matter. A comment on a plain share (no hand-in request) is
    keyed on the asset page and routed to whoever uploaded the version."""
    from apps.api.services import hub_events
    settings.hub_events_webhook_url = "https://hub.aditor.ai/api/revision/freeframe-webhook"
    settings.hub_events_webhook_secret = "s3cret"
    settings.frontend_url = FRONTEND
    try:
        db = _db_non_handin(editor_email="luk@aditor.ai", project_name="AgelessRx")
        project_id = uuid.uuid4()
        asset_id = uuid.uuid4()
        asset = SimpleNamespace(folder_id=uuid.uuid4(), project_id=project_id, id=asset_id,
                                name="sarah-bennet_nad_ugc.mp4", created_by=uuid.uuid4())
        version_id = uuid.uuid4()
        comment = SimpleNamespace(id=uuid.uuid4(), body="cut the intro, fix the logo",
                                  guest_author_id=uuid.uuid4(), visibility="public", version_id=version_id)

        sent = {}
        monkeypatch.setattr(hub_events.httpx, "post",
                            lambda url, content=None, headers=None, timeout=None: sent.update(json.loads(content)) or MagicMock())
        hub_events.announce_client_comment(db, comment, asset, "Mike")

        page = f"{FRONTEND}/projects/{project_id}/assets/{asset_id}"
        assert sent == {
            "event": "client_comment",
            "card_url": page,
            "editor_email": "luk@aditor.ai",
            "comment_id": str(comment.id),
            "comment_body": "cut the intro, fix the logo",
            "author_name": "Mike",
            "version_id": str(version_id),
            "review_url": page,
            "client": "AgelessRx",
            "title": "sarah-bennet_nad_ugc.mp4",
        }
    finally:
        settings.hub_events_webhook_url = ""
        settings.hub_events_webhook_secret = ""


def test_a_staff_author_comment_emits_nothing(monkeypatch):
    """A team member's comment (`author_id` set to a staff account, no `guest_author_id`) is never a
    client ask - not even when made while logged in to the app."""
    from apps.api.services import hub_events
    settings.hub_events_webhook_url = "https://example.invalid/hook"
    try:
        post = MagicMock()
        monkeypatch.setattr(hub_events.httpx, "post", post)
        db = MagicMock()
        db.get.side_effect = lambda model, pk: (
            SimpleNamespace(email="editor@aditor.ai", is_staff=True)
            if getattr(model, "__name__", "") == "User" else None
        )
        comment = SimpleNamespace(id=uuid.uuid4(), body="Looks good", author_id=uuid.uuid4(),
                                  guest_author_id=None, visibility="public", version_id=uuid.uuid4())
        hub_events.announce_client_comment(db, comment, MagicMock(), "A Teammate")
        post.assert_not_called()
    finally:
        settings.hub_events_webhook_url = ""


def test_an_authenticated_client_comment_routes_to_the_editor(monkeypatch):
    """Platform v2: a logged-in customer (is_staff=False) commenting in the app is a client ask and
    routes to the version's uploader, exactly like an anonymous guest comment."""
    from apps.api.services import hub_events
    settings.hub_events_webhook_url = "https://hub.aditor.ai/api/revision/freeframe-webhook"
    settings.hub_events_webhook_secret = "s3cret"
    settings.frontend_url = FRONTEND
    try:
        client_id = uuid.uuid4()
        uploader_id = uuid.uuid4()
        project_id = uuid.uuid4()
        asset_id = uuid.uuid4()
        version_id = uuid.uuid4()

        def fake_get(model, pk):
            name = getattr(model, "__name__", str(model))
            if name == "AssetVersion":
                return SimpleNamespace(created_by=uploader_id)
            if name == "User":
                if pk == client_id:
                    return SimpleNamespace(email="brand@customer.com", is_staff=False)
                return SimpleNamespace(email="luk@aditor.ai", is_staff=True)
            if name == "Project":
                return SimpleNamespace(name="AgelessRx")
            return None

        db = MagicMock()
        db.query.return_value.filter.return_value.first.return_value = None  # no hand-in request
        db.get.side_effect = fake_get

        asset = SimpleNamespace(folder_id=None, project_id=project_id, id=asset_id,
                                name="hook3.mp4", created_by=uploader_id)
        comment = SimpleNamespace(id=uuid.uuid4(), body="please cut the intro", author_id=client_id,
                                  guest_author_id=None, visibility="public", version_id=version_id)

        sent = {}
        monkeypatch.setattr(hub_events.httpx, "post",
                            lambda url, content=None, headers=None, timeout=None: sent.update(json.loads(content)) or MagicMock())
        hub_events.announce_client_comment(db, comment, asset, "Brand Owner")

        page = f"{FRONTEND}/projects/{project_id}/assets/{asset_id}"
        assert sent == {
            "event": "client_comment",
            "card_url": page,
            "editor_email": "luk@aditor.ai",
            "comment_id": str(comment.id),
            "comment_body": "please cut the intro",
            "author_name": "Brand Owner",
            "version_id": str(version_id),
            "review_url": page,
            "client": "AgelessRx",
            "title": "hook3.mp4",
        }
    finally:
        settings.hub_events_webhook_url = ""
        settings.hub_events_webhook_secret = ""


def test_a_client_who_is_also_the_uploader_is_not_pinged_about_their_own_comment(monkeypatch):
    """Customer-owned workspace edge: the commenter is also the version's uploader, so there is no
    separate editor to ping - stay silent rather than ping the client about their own comment."""
    from apps.api.services import hub_events
    settings.hub_events_webhook_url = "https://example.invalid/hook"
    settings.frontend_url = FRONTEND
    try:
        post = MagicMock()
        monkeypatch.setattr(hub_events.httpx, "post", post)
        person_id = uuid.uuid4()

        def fake_get(model, pk):
            name = getattr(model, "__name__", str(model))
            if name == "AssetVersion":
                return SimpleNamespace(created_by=person_id)
            if name == "User":
                return SimpleNamespace(email="brand@customer.com", is_staff=False)
            if name == "Project":
                return SimpleNamespace(name="Brand")
            return None

        db = MagicMock()
        db.query.return_value.filter.return_value.first.return_value = None
        db.get.side_effect = fake_get
        asset = SimpleNamespace(folder_id=None, project_id=uuid.uuid4(), id=uuid.uuid4(),
                                name="x.mp4", created_by=person_id)
        comment = SimpleNamespace(id=uuid.uuid4(), body="change this", author_id=person_id,
                                  guest_author_id=None, visibility="public", version_id=uuid.uuid4())
        hub_events.announce_client_comment(db, comment, asset, "Brand Owner")
        post.assert_not_called()
    finally:
        settings.hub_events_webhook_url = ""


def test_an_auto_review_finding_emits_nothing(monkeypatch):
    """The craft reviewer's guest comments are stored visibility="internal" at write time
    (routers/comments.py `_guest_comment_visibility` / `publish_review_comment`) - never a client ask."""
    from apps.api.services import hub_events
    settings.hub_events_webhook_url = "https://example.invalid/hook"
    try:
        post = MagicMock()
        monkeypatch.setattr(hub_events.httpx, "post", post)
        comment = SimpleNamespace(id=uuid.uuid4(), body="Must fix - color is off", guest_author_id=uuid.uuid4(),
                                  visibility="internal", version_id=uuid.uuid4())
        hub_events.announce_client_comment(MagicMock(), comment, MagicMock(), "Auto Review")
        post.assert_not_called()
    finally:
        settings.hub_events_webhook_url = ""


def test_a_comment_with_no_resolvable_editor_emits_nothing(monkeypatch):
    """No hand-in request and no uploader/creator email to resolve -> stay silent, never error."""
    from apps.api.services import hub_events
    settings.hub_events_webhook_url = "https://example.invalid/hook"
    settings.frontend_url = FRONTEND
    try:
        post = MagicMock()
        monkeypatch.setattr(hub_events.httpx, "post", post)
        db = MagicMock()
        db.query.return_value.filter.return_value.first.return_value = None
        db.get.return_value = None  # AssetVersion / User / Project all unresolved
        asset = SimpleNamespace(folder_id=None, project_id=uuid.uuid4(), id=uuid.uuid4(), name="x.mp4", created_by=None)
        comment = SimpleNamespace(id=uuid.uuid4(), body="please change this", guest_author_id=uuid.uuid4(),
                                  visibility="public", version_id=uuid.uuid4())
        hub_events.announce_client_comment(db, comment, asset, "A Client")
        post.assert_not_called()
    finally:
        settings.hub_events_webhook_url = ""


def test_a_completed_handin_version_posts_a_signed_revision_submitted_event(monkeypatch):
    from apps.api.services import hub_events
    settings.hub_events_webhook_url = "https://hub.aditor.ai/api/revision/freeframe-webhook"
    settings.hub_events_webhook_secret = "s3cret"
    try:
        folder_id = uuid.uuid4()
        req = _handin_request(folder_id=folder_id)
        db = _db_with_request(req)
        asset = SimpleNamespace(folder_id=folder_id)
        version_id = uuid.uuid4()

        sent = {}
        monkeypatch.setattr(hub_events.httpx, "post",
                            lambda url, content=None, headers=None, timeout=None: sent.update(json.loads(content)) or MagicMock())
        hub_events.announce_revision_submitted(db, asset, version_id)

        assert sent == {
            "event": "revision_submitted",
            "card_url": "https://feedback.aditor.ai/review/abc12345",
            "editor_email": "editor@aditor.ai",
            "version_id": str(version_id),
        }
    finally:
        settings.hub_events_webhook_url = ""
        settings.hub_events_webhook_secret = ""


def test_a_completed_version_outside_any_handin_resolves_by_asset(monkeypatch):
    from apps.api.services import hub_events
    settings.hub_events_webhook_url = "https://hub.aditor.ai/api/revision/freeframe-webhook"
    settings.hub_events_webhook_secret = "s3cret"
    settings.frontend_url = FRONTEND
    try:
        db = _db_non_handin(editor_email="luk@aditor.ai")
        project_id = uuid.uuid4()
        asset_id = uuid.uuid4()
        asset = SimpleNamespace(folder_id=None, project_id=project_id, id=asset_id, name="x.mp4", created_by=uuid.uuid4())
        version_id = uuid.uuid4()

        sent = {}
        monkeypatch.setattr(hub_events.httpx, "post",
                            lambda url, content=None, headers=None, timeout=None: sent.update(json.loads(content)) or MagicMock())
        hub_events.announce_revision_submitted(db, asset, version_id)

        page = f"{FRONTEND}/projects/{project_id}/assets/{asset_id}"
        assert sent == {
            "event": "revision_submitted",
            "card_url": page,
            "editor_email": "luk@aditor.ai",
            "version_id": str(version_id),
        }
    finally:
        settings.hub_events_webhook_url = ""
        settings.hub_events_webhook_secret = ""


def test_a_failing_webhook_never_breaks_the_comment_or_upload(monkeypatch):
    from apps.api.services import hub_events
    settings.hub_events_webhook_url = "https://example.invalid/hook"
    try:
        def boom(*a, **k):
            raise RuntimeError("network down")
        monkeypatch.setattr(hub_events.httpx, "post", boom)
        folder_id = uuid.uuid4()
        db = _db_with_request(_handin_request(folder_id=folder_id))
        asset = SimpleNamespace(folder_id=folder_id)
        comment = SimpleNamespace(id=uuid.uuid4(), body="x", guest_author_id=uuid.uuid4(),
                                  visibility="public", version_id=uuid.uuid4())
        hub_events.announce_client_comment(db, comment, asset, "A Client")   # must not raise
        hub_events.announce_revision_submitted(db, asset, uuid.uuid4())      # must not raise
    finally:
        settings.hub_events_webhook_url = ""


def test_a_completed_handin_version_also_posts_a_signed_portal_handin_event(monkeypatch):
    """When the portal webhook is configured, a completed hand-in version tells the portal the card's
    folder and the editor's direct upload link (/r/<token>) so a later revision deep-links to it.
    Fires even when the hub webhook is off - they are independent consumers."""
    from apps.api.services import hub_events
    settings.hub_events_webhook_url = ""  # hub off; portal on
    settings.portal_events_webhook_url = "https://app.aditor.ai/api/freeframe/handin-webhook"
    settings.portal_events_webhook_secret = "portalsecret"
    settings.frontend_url = FRONTEND
    try:
        folder_id = uuid.uuid4()
        card = "https://trello.com/c/AbCd1234"
        req = SimpleNamespace(folder_id=folder_id, token="tok_abc123",
                              iteration_state={"internal_handin": {"card_url": card, "editor_name": "Editor"}},
                              last_uploader_email="editor@aditor.ai")
        db = _db_with_request(req)
        asset = SimpleNamespace(folder_id=folder_id, project_id=None, id=None, name=None, created_by=None)
        version_id = uuid.uuid4()

        sent = {}

        def fake_post(url, content=None, headers=None, timeout=None):
            sent["url"] = url
            sent["content"] = content
            sent["headers"] = headers
            return MagicMock(status_code=200)

        monkeypatch.setattr(hub_events.httpx, "post", fake_post)
        hub_events.announce_revision_submitted(db, asset, version_id)

        assert sent["url"] == "https://app.aditor.ai/api/freeframe/handin-webhook"
        payload = json.loads(sent["content"])
        assert payload == {
            "event": "handin_uploaded",
            "card_url": card,
            "editor_email": "editor@aditor.ai",
            "version_id": str(version_id),
            "folder_id": str(folder_id),
            "handin_url": f"{FRONTEND}/r/tok_abc123",
        }
        expected_sig = hmac.new(b"portalsecret", sent["content"], hashlib.sha256).hexdigest()
        assert sent["headers"]["X-Aditor-Signature"] == expected_sig
    finally:
        settings.portal_events_webhook_url = ""
        settings.portal_events_webhook_secret = ""


def test_a_staff_upload_into_a_handin_folder_still_tells_the_portal(monkeypatch):
    """An editor signed in to FreeFrame uploads into a portal-made hand-in folder (routers/upload.py
    `complete`): the request has no guest uploader email, because only the /r/<token> lane records one.
    The file is real, so the portal must hear about it, keyed on the card, attributed to the version's
    uploader. VEL-022, 2026-11-01: three files landed, the portal never knew."""
    from apps.api.services import hub_events
    settings.hub_events_webhook_url = ""
    settings.portal_events_webhook_url = "https://app.aditor.ai/api/freeframe/handin-webhook"
    settings.portal_events_webhook_secret = "portalsecret"
    settings.frontend_url = FRONTEND
    try:
        card = "https://trello.com/c/ilukhhho"
        folder_id = uuid.uuid4()
        req = _handin_request(card_url=card, folder_id=folder_id, editor_email=None)
        req.token = "tok_abc123"
        db = _db_non_handin(editor_email="arianna@aditor.ai")
        db.query.return_value.filter.return_value.first.return_value = req
        asset = SimpleNamespace(folder_id=folder_id, project_id=None, id=None, name=None, created_by=None)
        version_id = uuid.uuid4()

        sent = []
        monkeypatch.setattr(hub_events.httpx, "post", lambda url, content=None, headers=None, timeout=None: sent.append(content) or MagicMock(status_code=200))
        hub_events.announce_revision_submitted(db, asset, version_id)

        assert len(sent) == 1
        payload = json.loads(sent[0])
        assert payload["event"] == "handin_uploaded"
        assert payload["card_url"] == card
        assert payload["editor_email"] == "arianna@aditor.ai"
        assert payload["folder_id"] == str(folder_id)
    finally:
        settings.portal_events_webhook_url = ""
        settings.portal_events_webhook_secret = ""


def test_portal_handin_event_is_off_by_default_and_skips_non_handin(monkeypatch):
    """No portal webhook configured -> nothing to the portal. And a non-hand-in upload (no folder_id)
    never posts a portal event even when it is configured."""
    from apps.api.services import hub_events
    settings.hub_events_webhook_url = ""
    settings.frontend_url = FRONTEND

    # Off by default: no portal URL.
    settings.portal_events_webhook_url = ""
    assert hub_events.portal_is_enabled() is False
    post = MagicMock()
    monkeypatch.setattr(hub_events.httpx, "post", post)
    folder_id = uuid.uuid4()
    db = _db_with_request(SimpleNamespace(folder_id=folder_id, token="t",
                          iteration_state={"internal_handin": {"card_url": "https://trello.com/c/AbCd1234"}},
                          last_uploader_email="e@aditor.ai"))
    hub_events.announce_revision_submitted(db, SimpleNamespace(folder_id=folder_id, project_id=None, id=None, name=None, created_by=None), uuid.uuid4())
    post.assert_not_called()

    # Configured, but a non-hand-in upload (no hand-in request -> no card/folder) sends nothing.
    settings.portal_events_webhook_url = "https://app.aditor.ai/api/freeframe/handin-webhook"
    try:
        post2 = MagicMock()
        monkeypatch.setattr(hub_events.httpx, "post", post2)
        db2 = _db_non_handin(editor_email="luk@aditor.ai")
        asset = SimpleNamespace(folder_id=None, project_id=uuid.uuid4(), id=uuid.uuid4(), name="x.mp4", created_by=uuid.uuid4())
        hub_events.announce_revision_submitted(db2, asset, uuid.uuid4())
        # The asset-page event has no folder_id, so no portal post.
        assert not any(c.args and "app.aditor.ai" in str(c.args[0]) for c in post2.call_args_list)
    finally:
        settings.portal_events_webhook_url = ""


def test_handin_helper_edges():
    from apps.api.services import hub_events
    # No folder -> not a hand-in.
    assert hub_events._handin_request_for_asset(MagicMock(), None) is None
    assert hub_events._handin_request_for_asset(MagicMock(), SimpleNamespace(folder_id=None)) is None
    # A regular (external editor) file request has no `internal_handin` key - never a hand-in.
    folder_id = uuid.uuid4()
    req = SimpleNamespace(folder_id=folder_id, iteration_state={"submitted": True}, last_uploader_email="x@y.com")
    db = _db_with_request(req)
    assert hub_events._handin_request_for_asset(db, SimpleNamespace(folder_id=folder_id)) is None
