"""POST /integrations/portal/workspace: the portal finds or creates a brand's workspace.

Real-Postgres (via `real_db`) because the point is idempotent find-or-create plus the advisory lock
that serialises two activations of one brand - things a mocked Session cannot show.
"""
import hashlib
import hmac
import json
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

from apps.api.config import settings
from apps.api.database import engine, get_db
from apps.api.models.project import Project, ProjectMember, ProjectRole, ProjectType
from apps.api.models.share import ShareLink, SharePermission
from apps.api.models.user import User
from apps.api.routers.portal import router
from apps.api.services import automation_share

SECRET = "portal-test-secret"
PATH = "/integrations/portal/workspace"


@pytest.fixture
def portal_app(real_db, monkeypatch):
    monkeypatch.setattr(settings, "portal_freeframe_hmac_secret", SECRET)
    monkeypatch.setattr(settings, "automation_share_webhook_url", "")
    service = User(email=f"portal-service-{uuid.uuid4()}@example.test", name="Portal Service", is_staff=True)
    real_db.add(service)
    real_db.flush()
    monkeypatch.setattr(settings, "portal_freeframe_service_email", service.email)
    real_db.commit()
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_db] = lambda: real_db
    with TestClient(app) as client:
        yield client, real_db, service


def _post(client, payload, secret=SECRET):
    body = json.dumps(payload).encode("utf-8")
    headers = {"content-type": "application/json"}
    if secret is not None:
        headers["X-Aditor-Signature"] = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return client.post(PATH, content=body, headers=headers)


def _workspace(db, name, creator, *, is_workspace=True, deleted=False):
    project = Project(name=name, is_workspace=is_workspace, project_type=ProjectType.team, created_by=creator.id)
    if deleted:
        from datetime import datetime, timezone
        project.deleted_at = datetime.now(timezone.utc)
    db.add(project)
    db.commit()
    return project


def _unique(prefix):
    # Real Postgres may hold other workspaces: give every test brand a key nothing else has.
    return f"{prefix} {uuid.uuid4().hex[:10]}"


# -- trust ------------------------------------------------------------------------------------------

def test_missing_signature_is_401(portal_app):
    client, _db, _service = portal_app
    assert _post(client, {"name": "Bitterliebe"}, secret=None).status_code == 401


def test_wrong_signature_is_401(portal_app):
    client, _db, _service = portal_app
    assert _post(client, {"name": "Bitterliebe"}, secret="not-the-secret").status_code == 401


def test_unconfigured_secret_fails_closed(portal_app, monkeypatch):
    client, _db, _service = portal_app
    monkeypatch.setattr(settings, "portal_freeframe_hmac_secret", "")
    assert _post(client, {"name": "Bitterliebe"}).status_code == 401


def test_a_signature_over_a_different_body_is_refused(portal_app):
    client, db, _service = portal_app
    signed = json.dumps({"name": "Innocent"}).encode()
    sig = hmac.new(SECRET.encode(), signed, hashlib.sha256).hexdigest()
    response = client.post(PATH, content=json.dumps({"name": "Tampered"}).encode(),
                           headers={"content-type": "application/json", "X-Aditor-Signature": sig})
    assert response.status_code == 401
    assert db.query(Project).filter(Project.name == "Tampered").count() == 0


# -- validation -------------------------------------------------------------------------------------

@pytest.mark.parametrize("name", ["", "   ", "!!!", "(Peturo GmbH)", "x" * 256])
def test_a_name_with_nothing_to_match_on_is_422(portal_app, name):
    client, _db, _service = portal_app
    assert _post(client, {"name": name}).status_code == 422


def test_a_body_without_a_name_is_422(portal_app):
    client, _db, _service = portal_app
    assert _post(client, {"board_url": "https://trello.com/b/abc123"}).status_code == 422


def test_a_board_url_that_is_not_a_trello_board_is_400(portal_app):
    client, _db, _service = portal_app
    assert _post(client, {"name": _unique("Brand"), "board_url": "https://evil.example/b/abc"}).status_code == 400


def test_misconfigured_service_account_is_503(portal_app, monkeypatch):
    client, _db, _service = portal_app
    monkeypatch.setattr(settings, "portal_freeframe_service_email", "")
    assert _post(client, {"name": _unique("Brand")}).status_code == 503


# -- find or create ---------------------------------------------------------------------------------

def test_creates_a_workspace_owned_by_the_service_account(portal_app):
    client, db, service = portal_app
    name = _unique("Bitterliebe")
    response = _post(client, {"name": name, "board_url": "https://trello.com/b/brd9"})
    assert response.status_code == 200
    out = response.json()
    assert out["created"] is True
    project = db.query(Project).filter(Project.id == uuid.UUID(out["project_id"])).one()
    assert project.name == name
    assert project.is_workspace is True
    assert project.project_type == ProjectType.team
    assert project.description == "https://trello.com/b/brd9"
    assert project.created_by == service.id
    member = db.query(ProjectMember).filter(ProjectMember.project_id == project.id).one()
    assert member.user_id == service.id and member.role == ProjectRole.owner


def test_without_a_board_the_description_stays_empty(portal_app):
    client, db, _service = portal_app
    out = _post(client, {"name": _unique("Boardless")}).json()
    assert db.query(Project).filter(Project.id == uuid.UUID(out["project_id"])).one().description is None


def test_creates_the_standing_automation_link_and_announces_it_after_commit(portal_app, monkeypatch):
    client, db, service = portal_app
    monkeypatch.setattr(settings, "automation_share_webhook_url", "https://review.example.test/hook")
    announced = []
    monkeypatch.setattr(automation_share, "announce", lambda project, link: announced.append((project.id, link.token)))
    out = _post(client, {"name": _unique("Linked")}).json()
    project_id = uuid.UUID(out["project_id"])
    link = db.query(ShareLink).filter(ShareLink.project_id == project_id).one()
    assert link.permission == SharePermission.comment
    assert link.allow_download is True
    assert link.created_by == service.id
    assert announced == [(project_id, link.token)]


def test_no_automation_link_when_the_webhook_is_off(portal_app):
    client, db, _service = portal_app
    out = _post(client, {"name": _unique("Quiet")}).json()
    assert db.query(ShareLink).filter(ShareLink.project_id == uuid.UUID(out["project_id"])).count() == 0


def test_a_second_call_returns_the_same_workspace(portal_app):
    client, db, _service = portal_app
    name = _unique("Twice")
    first = _post(client, {"name": name}).json()
    second = _post(client, {"name": name}).json()
    assert first["created"] is True and second["created"] is False
    assert first["project_id"] == second["project_id"]
    assert db.query(Project).filter(Project.name == name).count() == 1


@pytest.mark.parametrize("existing_fmt,asked_fmt", [
    ("{b} - Workspace", "{b}"),                    # auto-backfilled workspace vs bare brand
    ("{b}", "{b} GmbH"),                           # legal suffix
    ("{b} - Workspace", "{b} (Peturo GmbH)"),      # parenthetical owner
    ("{b}", "{b} / DailyRituals"),                 # slash alias
    ("{b}", "{B}"),                                # case and spacing
])
def test_links_an_existing_workspace_whose_name_normalises_equal(portal_app, existing_fmt, asked_fmt):
    client, db, service = portal_app
    brand = f"Brand{uuid.uuid4().hex[:10]}"
    existing = _workspace(db, existing_fmt.format(b=brand), service)
    asked = asked_fmt.format(b=brand, B=" ".join(brand.upper()))
    out = _post(client, {"name": asked}).json()
    assert out == {"project_id": str(existing.id), "created": False}


def test_links_the_keller_alias(portal_app):
    client, db, service = portal_app
    existing = _workspace(db, "Keller Gesundheit - Workspace", service)
    out = _post(client, {"name": "Keller Gesundheitspflege GmbH"}).json()
    assert out == {"project_id": str(existing.id), "created": False}


def test_the_oldest_matching_workspace_wins(portal_app):
    client, db, service = portal_app
    brand = f"Brand{uuid.uuid4().hex[:10]}"
    older = _workspace(db, brand, service)
    newer = _workspace(db, f"{brand} - Workspace", service)
    # One test transaction stamps both rows with the same now(); make the age explicit.
    from datetime import timedelta
    older.created_at = newer.created_at - timedelta(days=30)
    db.commit()
    assert _post(client, {"name": brand}).json()["project_id"] == str(older.id)


def test_ignores_deleted_non_workspace_and_customer_owned_projects(portal_app):
    client, db, service = portal_app
    brand = f"Brand{uuid.uuid4().hex[:10]}"
    customer = User(email=f"customer-{uuid.uuid4()}@example.test", name="Customer", is_staff=False)
    db.add(customer)
    db.flush()
    _workspace(db, brand, service, deleted=True)
    _workspace(db, brand, service, is_workspace=False)
    _workspace(db, brand, customer)
    out = _post(client, {"name": brand}).json()
    assert out["created"] is True
    assert db.query(Project).filter(Project.id == uuid.UUID(out["project_id"])).one().created_by == service.id


def test_concurrent_calls_for_one_brand_key_are_serialised(portal_app):
    """While another transaction holds the brand's lock, the endpoint waits instead of creating."""
    client, db, _service = portal_app
    brand = f"Brand{uuid.uuid4().hex[:10]}"
    holder = engine.connect()
    holder_tx = holder.begin()
    try:
        holder.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:ref, 0))"),
                       {"ref": f"portal-workspace:{brand.lower()}"})
        db.execute(text("SET LOCAL lock_timeout = '300ms'"))
        with pytest.raises(OperationalError):
            _post(client, {"name": f"{brand} GmbH"})  # same key as `brand`
    finally:
        holder_tx.rollback()
        holder.close()
