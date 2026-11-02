"""POST /integrations/portal/delivery-folder: the portal's server-to-server hand-in endpoint.

Real-Postgres (via the `real_db` fixture) because the endpoint's whole point is idempotent
find-or-create across folder + share + request - exactly the kind of multi-row interaction a
hand-mocked Session hides bugs in.
"""
import hashlib
import hmac
import json
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from apps.api.config import settings
from apps.api.database import get_db
from apps.api.models.checklist_binding import ChecklistBinding
from apps.api.models.folder import Folder
from apps.api.models.project import Project
from apps.api.models.share import ShareLink, SharePermission
from apps.api.models.upload_request import UploadRequest
from apps.api.models.user import User
from apps.api.routers import portal as portal_module
from apps.api.routers.portal import router
from apps.api.services.checklists import reserve_binding

SECRET = "portal-test-secret"
CARD_URL = "https://trello.com/c/AbCd1234"


@pytest.fixture
def portal_app(real_db, monkeypatch):
    monkeypatch.setattr(settings, "portal_freeframe_hmac_secret", SECRET)
    monkeypatch.setattr(settings, "frontend_url", "https://feedback.example.test")
    dispatched = []
    monkeypatch.setattr(portal_module, "dispatch_binding", dispatched.append)
    service = User(email=f"portal-service-{uuid.uuid4()}@example.test", name="Portal Service", is_staff=True)
    real_db.add(service)
    real_db.flush()
    monkeypatch.setattr(settings, "portal_freeframe_service_email", service.email)
    project = Project(name="Brand workspace", is_workspace=True, created_by=service.id)
    real_db.add(project)
    real_db.commit()
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_db] = lambda: real_db
    with TestClient(app) as client:
        client.dispatched = dispatched
        yield client, real_db, project, service


def _post(client, payload, secret=SECRET):
    body = json.dumps(payload).encode("utf-8")
    headers = {"content-type": "application/json"}
    if secret is not None:
        headers["X-Aditor-Signature"] = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return client.post("/integrations/portal/delivery-folder", content=body, headers=headers)


def test_missing_signature_is_401(portal_app):
    client, _db, project, _service = portal_app
    response = _post(client, {"card_url": CARD_URL, "workspace_project_id": str(project.id)}, secret=None)
    assert response.status_code == 401


def test_wrong_signature_is_401(portal_app):
    client, _db, project, _service = portal_app
    response = _post(client, {"card_url": CARD_URL, "workspace_project_id": str(project.id)}, secret="not-the-secret")
    assert response.status_code == 401


def test_unconfigured_secret_fails_closed(portal_app, monkeypatch):
    client, _db, project, _service = portal_app
    monkeypatch.setattr(settings, "portal_freeframe_hmac_secret", "")
    response = _post(client, {"card_url": CARD_URL, "workspace_project_id": str(project.id)})
    assert response.status_code == 401


def test_malformed_card_url_is_400(portal_app):
    client, _db, project, _service = portal_app
    response = _post(client, {"card_url": "https://trello.com/boards/not-a-card", "workspace_project_id": str(project.id)})
    assert response.status_code == 400


def test_unknown_workspace_is_404(portal_app):
    client, _db, _project, _service = portal_app
    response = _post(client, {"card_url": CARD_URL, "workspace_project_id": str(uuid.uuid4())})
    assert response.status_code == 404


def test_misconfigured_service_account_is_503(portal_app, monkeypatch):
    client, _db, project, _service = portal_app
    monkeypatch.setattr(settings, "portal_freeframe_service_email", "")
    response = _post(client, {"card_url": CARD_URL, "workspace_project_id": str(project.id)})
    assert response.status_code == 503


def test_first_call_creates_folder_request_and_share_attributed_to_the_service_account(portal_app):
    client, db, project, service = portal_app
    response = _post(client, {"card_url": CARD_URL, "workspace_project_id": str(project.id), "title": "Spring launch"})
    assert response.status_code == 200
    out = response.json()
    assert out["upload_url"] == f"https://feedback.example.test/r/{out['token']}"
    assert out["review_url"] == f"https://feedback.example.test/share/{out['review_share_token']}"

    folder = db.query(Folder).filter(Folder.id == uuid.UUID(out["folder_id"])).one()
    assert folder.project_id == project.id
    assert folder.name == "Spring launch"
    assert folder.description == CARD_URL
    assert folder.created_by == service.id

    req = db.query(UploadRequest).filter(UploadRequest.folder_id == folder.id).one()
    assert req.token == out["token"]
    assert req.created_by == service.id
    assert req.review_share_token == out["review_share_token"]

    share = db.query(ShareLink).filter(ShareLink.folder_id == folder.id).one()
    assert share.token == out["review_share_token"]
    assert share.permission == SharePermission.comment
    assert share.allow_download is True
    assert share.created_by == service.id


def test_a_folder_with_no_title_is_named_after_the_card_key(portal_app):
    client, db, project, _service = portal_app
    response = _post(client, {"card_url": CARD_URL, "workspace_project_id": str(project.id)})
    folder = db.query(Folder).filter(Folder.id == uuid.UUID(response.json()["folder_id"])).one()
    assert folder.name == "AbCd1234"


def test_two_calls_for_the_same_card_are_idempotent(portal_app):
    client, db, project, _service = portal_app
    payload = {"card_url": CARD_URL, "workspace_project_id": str(project.id), "title": "Spring launch"}
    first = _post(client, payload).json()
    second = _post(client, payload).json()

    assert first == second
    assert db.query(Folder).filter(Folder.project_id == project.id).count() == 1
    assert db.query(UploadRequest).filter(UploadRequest.folder_id == uuid.UUID(first["folder_id"])).count() == 1
    assert db.query(ShareLink).filter(ShareLink.folder_id == uuid.UUID(first["folder_id"])).count() == 1


def test_reuses_a_folder_the_interactive_handin_flow_already_created_for_the_same_card(portal_app):
    client, db, project, service = portal_app
    existing = Folder(project_id=project.id, name="Already filed", description=CARD_URL, created_by=service.id)
    db.add(existing)
    db.commit()

    response = _post(client, {"card_url": CARD_URL, "workspace_project_id": str(project.id)})
    assert response.status_code == 200
    assert response.json()["folder_id"] == str(existing.id)
    assert db.query(Folder).filter(Folder.project_id == project.id).count() == 1


# Auto Review only hears of a hand-in through its checklist binding (register_request runs from the
# binding's task). A portal hand-in without one showed "Review unavailable" for good and could not finish.

def test_first_call_reserves_the_binding_that_registers_the_handin_with_auto_review(portal_app):
    client, db, project, service = portal_app
    out = _post(client, {"card_url": CARD_URL, "workspace_project_id": str(project.id), "title": "Spring launch"}).json()

    req = db.query(UploadRequest).filter(UploadRequest.token == out["token"]).one()
    binding = db.query(ChecklistBinding).filter(ChecklistBinding.folder_id == uuid.UUID(out["folder_id"])).one()
    assert binding.request_id == req.id
    assert binding.project_id == project.id
    assert binding.review_share_token == out["review_share_token"]
    assert binding.created_by == service.id
    assert binding.source_key == f"portal:{req.id}"
    assert binding.intent["brief_url"] == CARD_URL
    assert binding.intent["brand"] == req.brand_slug
    assert client.dispatched == [binding.id]


def test_a_repeated_call_keeps_the_one_binding(portal_app):
    client, db, project, _service = portal_app
    payload = {"card_url": CARD_URL, "workspace_project_id": str(project.id)}
    first = _post(client, payload).json()
    second = _post(client, payload).json()

    assert first == second
    rows = db.query(ChecklistBinding).filter(ChecklistBinding.folder_id == uuid.UUID(first["folder_id"])).all()
    assert len(rows) == 1
    assert client.dispatched == [rows[0].id, rows[0].id]


def test_a_folder_that_already_has_a_binding_keeps_it(portal_app):
    client, db, project, service = portal_app
    existing = Folder(project_id=project.id, name="Already filed", description=CARD_URL, created_by=service.id)
    db.add(existing)
    db.flush()
    staff = reserve_binding(db, project.id, service.id, "trello:0123456789abcdef01234567",
                            {"brand": "", "title": "", "brief_text": "", "brief_url": CARD_URL, "brief_pdf_base64": ""})
    staff.folder_id = existing.id
    db.commit()

    out = _post(client, {"card_url": CARD_URL, "workspace_project_id": str(project.id)}).json()

    rows = db.query(ChecklistBinding).filter(ChecklistBinding.folder_id == existing.id).all()
    assert [r.id for r in rows] == [staff.id]
    assert rows[0].request_id == db.query(UploadRequest).filter(UploadRequest.token == out["token"]).one().id
    assert rows[0].review_share_token == out["review_share_token"]
    assert client.dispatched == [staff.id]
