"""Whop identity, provisioning and continuing entitlement boundaries (mock DB)."""
import time
import uuid
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import HTTPException
from jose import jwt

from apps.api.config import settings
from apps.api.models.user import User, UserStatus
from apps.api.services import whop_auth as service


def token(**over):
    return jwt.encode({"aud": "aditor-suite:owner", "exp": int(time.time()) + 600,
                       "accountId": "account-a", "brandId": "brand-a", "email": "owner@example.com", **over},
                      "test-only", algorithm="HS256")


def customer(**over):
    return User(id=uuid.uuid4(), email="owner@example.com", name="Owner", status=UserStatus.active,
                is_staff=False, is_superadmin=False, token_version=1, suite_account_id="account-a",
                suite_brand_id="brand-a", **over)


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(settings, "suite_url", "https://suite.example.test")
    monkeypatch.setattr(settings, "whop_app_id", "app_review")


@pytest.fixture
def redis(monkeypatch):
    cache = {}
    r = MagicMock()
    r.get.side_effect = lambda key: cache.get(key)
    r.setex.side_effect = lambda key, ttl, value: cache.__setitem__(key, value)
    r.delete.side_effect = lambda key: cache.pop(key, None)
    monkeypatch.setattr(service, "get_redis", lambda: r)
    return r


def stub_suite(monkeypatch, owner_token=None, allow=True):
    calls = []
    def post(url, **kwargs):
        calls.append((url, kwargs))
        body = {"token": owner_token or token()} if url.endswith("/auth/owner") else {"allow": allow}
        return httpx.Response(200, json=body)
    monkeypatch.setattr(service.httpx, "post", post)
    return calls


def test_exchange_uses_fixed_review_app_and_checks_entitlement(monkeypatch):
    calls = stub_suite(monkeypatch)
    whop = jwt.encode({"aud": "app_review", "exp": int(time.time()) + 60}, "test", algorithm="HS256")
    owner = service.exchange_whop_token(whop)
    assert owner.account_id == "account-a"
    assert calls[0][1]["headers"]["x-suite-app"] == "review"
    assert calls[1][1]["json"] == {"tool": "autoreview"}


@pytest.mark.parametrize("claims", [{"aud": "another-app"}, {"exp": 1}])
def test_wrong_app_or_expired_whop_token_rejected_before_exchange(monkeypatch, claims):
    calls = stub_suite(monkeypatch)
    with pytest.raises(HTTPException):
        service.exchange_whop_token(jwt.encode({"aud": "app_review", "exp": int(time.time()) + 60, **claims}, "test"))
    assert not calls


@pytest.mark.parametrize("claims", [{"aud": "aditor-suite:editor"}, {"exp": 1}, {"accountId": ""}, {"email": None}])
def test_invalid_owner_claims_never_provision(claims):
    with pytest.raises(HTTPException):
        service.owner_from_token(token(**claims))


def test_denied_membership_and_outage_do_not_provision(monkeypatch):
    stub_suite(monkeypatch, allow=False)
    with pytest.raises(HTTPException) as exc:
        service.check_entitlement(token())
    assert exc.value.status_code == 403
    monkeypatch.setattr(service.httpx, "post", MagicMock(side_effect=httpx.ConnectError("offline")))
    with pytest.raises(HTTPException) as exc:
        service.check_entitlement(token())
    assert exc.value.status_code == 503


def test_new_account_is_customer_and_identity_bound(mock_db):
    owner = service.owner_from_token(token())
    user = service.resolve_customer(mock_db, owner)
    assert user.suite_account_id == "account-a" and user.suite_brand_id == "brand-a"
    assert user.is_staff is False and user.is_superadmin is False
    assert user.status == UserStatus.active


def test_existing_identity_reuses_account(mock_db):
    existing = customer()
    mock_db.first.return_value = existing
    assert service.resolve_customer(mock_db, service.owner_from_token(token())) is existing
    mock_db.add.assert_not_called()


@pytest.mark.parametrize("change", [{"is_staff": True}, {"is_superadmin": True},
    {"deleted_at": "deleted"}, {"status": UserStatus.deactivated},
    {"suite_account_id": "other-account"}, {"suite_brand_id": "other-brand"}])
def test_conflicting_or_disabled_identity_never_adopted(mock_db, change):
    user = customer()
    for key, value in change.items():
        setattr(user, key, value)
    mock_db.first.return_value = user
    with pytest.raises(HTTPException):
        service.resolve_customer(mock_db, service.owner_from_token(token()))
    mock_db.add.assert_not_called()


def test_email_collision_is_not_an_account_link(mock_db):
    mock_db.first.side_effect = [None, customer()]
    with pytest.raises(HTTPException) as exc:
        service.resolve_customer(mock_db, service.owner_from_token(token(accountId="new-account", brandId="new-brand")))
    assert exc.value.status_code == 409
    mock_db.add.assert_not_called()


def test_unique_constraint_race_fails_closed(mock_db):
    from sqlalchemy.exc import IntegrityError
    mock_db.commit.side_effect = IntegrityError("insert", {}, Exception())
    with pytest.raises(HTTPException) as exc:
        service.resolve_customer(mock_db, service.owner_from_token(token()))
    assert exc.value.status_code == 409
    mock_db.rollback.assert_called_once()


def test_session_is_server_side_and_rechecks_revocation(monkeypatch, redis):
    user = customer()
    owner = service.owner_from_token(token())
    service.store_owner_session(user, owner)
    calls = stub_suite(monkeypatch)
    service.require_customer_entitlement(user)
    assert len(calls) == 1
    service.require_customer_entitlement(user)
    assert len(calls) == 1  # bounded cache, no HTTP per component
    redis.delete(service.gate_key(user.id))
    stub_suite(monkeypatch, allow=False)
    with pytest.raises(HTTPException) as exc:
        service.require_customer_entitlement(user)
    assert exc.value.status_code == 403


def test_missing_session_and_cross_customer_session_rejected(redis):
    user = customer()
    with pytest.raises(HTTPException):
        service.require_customer_entitlement(user)
    redis.setex(service.session_key(user.id), 600, token(accountId="someone-else"))
    with pytest.raises(HTTPException):
        service.require_customer_entitlement(user)


def test_ordinary_accounts_do_not_depend_on_suite(monkeypatch):
    call = MagicMock(side_effect=AssertionError("must not contact Suite"))
    monkeypatch.setattr(service, "get_redis", call)
    service.require_customer_entitlement(User(email="staff@example.com", name="Staff"))
    call.assert_not_called()


def test_refresh_cannot_bypass_missing_whop_session(client, monkeypatch, redis):
    from apps.api.routers import auth
    from apps.api.services.auth_service import create_refresh_token
    user = customer()
    monkeypatch.setattr(auth, "get_user_by_id", lambda *args: user)
    result = client.post("/auth/refresh", json={"refresh_token": create_refresh_token(str(user.id))})
    assert result.status_code == 401


def test_exchange_endpoint_requires_header(client):
    assert client.post("/auth/whop", json={"email": "someone@example.test"}).status_code == 401


def test_whop_customer_can_create_brand_without_internal_trello_link(mock_db, monkeypatch):
    from apps.api.routers.projects import create_project
    from apps.api.schemas.project import ProjectCreate
    from apps.api.models.project import ProjectMember, ProjectRole
    from apps.api.services.permissions import implicit_project_role
    monkeypatch.setattr(settings, 'require_project_description_pattern', r'trello\.com/c/')
    monkeypatch.setattr(settings, 'instance_wide_project_access', True)
    user = customer()
    project = create_project(ProjectCreate(name='My brand'), mock_db, user)
    assert project.created_by == user.id
    membership = next(call.args[0] for call in mock_db.add.call_args_list if isinstance(call.args[0], ProjectMember))
    assert membership.user_id == user.id and membership.role == ProjectRole.owner
    assert implicit_project_role(user) is None


def test_access_token_cannot_bypass_revoked_membership(client, monkeypatch, redis):
    from apps.api.middleware import auth
    from apps.api.services.auth_service import create_access_token
    user = customer()
    service.store_owner_session(user, service.owner_from_token(token()))
    stub_suite(monkeypatch, allow=False)
    monkeypatch.setattr(auth, 'get_user_by_id', lambda *args: user)
    result = client.get('/auth/me', headers={'Authorization': f'Bearer {create_access_token(str(user.id))}'})
    assert result.status_code == 403


def test_whop_session_returns_only_freeframe_credentials(client, mock_db, monkeypatch, redis):
    from apps.api.services.auth_service import decode_token
    user = customer()
    mock_db.first.return_value = user
    stub_suite(monkeypatch)
    whop = jwt.encode({'aud': 'app_review', 'exp': int(time.time()) + 60}, 'test', algorithm='HS256')
    result = client.post('/auth/whop', headers={'x-whop-user-token': whop})
    assert result.status_code == 200
    body = result.json()
    assert decode_token(body['access_token'])['sub'] == str(user.id)
    assert 'accountId' not in decode_token(body['access_token'])
    assert 'token' not in body


def test_expired_and_missing_exp_owner_tokens_rejected():
    expired = token(exp=1)
    with pytest.raises(HTTPException):
        service.owner_from_token(expired)
    without_exp = jwt.encode({'aud': 'aditor-suite:owner', 'accountId': 'a', 'brandId': 'b'}, 'test')
    with pytest.raises(HTTPException):
        service.owner_from_token(without_exp)


def test_open_event_stream_stops_before_emitting_after_revocation(monkeypatch):
    import asyncio
    from apps.api.routers import events
    closed = []
    async def messages(project_id):
        try:
            yield 'first'
            yield 'must not leak'
        finally:
            closed.append(True)
    monkeypatch.setattr(events, 'event_stream', messages)
    check = MagicMock(side_effect=[None, HTTPException(403, 'revoked')])
    monkeypatch.setattr(events, 'require_customer_entitlement', check)
    async def collect():
        return [message async for message in events.customer_event_stream('project', customer())]
    assert asyncio.run(collect()) == ['first']
    assert closed == [True]


def trial_context(paid=False):
    from apps.api.services.campaign_access import TELEHEALTH
    return {**TELEHEALTH, 'state': 'active', 'previewOnly': not paid}


def test_cached_trial_cannot_cross_cutoff(monkeypatch, redis):
    from apps.api.services import campaign_access
    user = customer(suite_campaign=trial_context())
    service.store_owner_session(user, service.owner_from_token(token(exp=max(campaign_access.ENDS_AT_TIMESTAMP, int(time.time())) + 600)))
    redis.setex(service.gate_key(user.id), 60, redis.get(service.session_key(user.id)))
    monkeypatch.setattr(service.time, 'time', lambda: campaign_access.ENDS_AT_TIMESTAMP)
    monkeypatch.setattr(service, '_post', lambda *a, **k: {'allow': False, 'reason': 'campaign_expired', 'campaign': trial_context()})
    with pytest.raises(HTTPException) as exc:
        service.require_customer_entitlement(user)
    assert exc.value.status_code == 403
    assert exc.value.detail['code'] == 'campaign_expired'


def test_expired_trial_preserves_identity_but_not_tool_access(monkeypatch, redis):
    from apps.api.services import campaign_access
    user = customer(suite_campaign=trial_context())
    owner_token = token(exp=max(campaign_access.ENDS_AT_TIMESTAMP, int(time.time())) + 600)
    service.store_owner_session(user, service.owner_from_token(owner_token))
    monkeypatch.setattr(service.time, 'time', lambda: campaign_access.ENDS_AT_TIMESTAMP)
    monkeypatch.setattr(service, '_post', lambda *a, **k: {'allow': False, 'reason': 'campaign_expired', 'campaign': trial_context()})
    service.require_customer_entitlement(user, allow_expired=True)
    assert user.suite_campaign['state'] == 'expired'
    with pytest.raises(HTTPException):
        service.require_customer_entitlement(user)


def test_identity_exception_does_not_allow_revoked_membership(monkeypatch, redis):
    user = customer(suite_campaign=trial_context())
    service.store_owner_session(user, service.owner_from_token(token()))
    monkeypatch.setattr(service, '_post', lambda *a, **k: {'allow': False, 'reason': 'membership_inactive', 'campaign': trial_context()})
    with pytest.raises(HTTPException) as exc:
        service.require_customer_entitlement(user, allow_expired=True)
    assert exc.value.status_code == 403


def test_paid_upgrade_updates_trusted_campaign(monkeypatch, redis):
    user = customer(suite_campaign=trial_context())
    service.store_owner_session(user, service.owner_from_token(token()))
    monkeypatch.setattr(service, '_post', lambda *a, **k: {'allow': True, 'campaign': trial_context(paid=True)})
    service.require_customer_entitlement(user)
    assert user.suite_campaign['previewOnly'] is False


def test_first_whop_signin_starts_with_one_private_brand_workspace(client, mock_db, monkeypatch, redis):
    from apps.api.models.project import Project, ProjectMember, ProjectRole
    calls = stub_suite(monkeypatch)
    mock_db.order_by.return_value = mock_db
    whop = jwt.encode({'aud': 'app_review', 'exp': int(time.time()) + 60}, 'test', algorithm='HS256')
    result = client.post('/auth/whop', headers={'x-whop-user-token': whop})
    assert result.status_code == 200
    projects = [c.args[0] for c in mock_db.add.call_args_list if isinstance(c.args[0], Project)]
    assert len(projects) == 1
    project = projects[0]
    assert project.name == 'My brand' and project.is_workspace is True and project.is_public is False
    member = next(c.args[0] for c in mock_db.add.call_args_list if isinstance(c.args[0], ProjectMember))
    assert member.project_id == project.id and member.user_id == project.created_by
    assert member.role == ProjectRole.owner


def test_workspace_reuses_only_existing_owned_project_and_preserves_name(mock_db):
    from apps.api.models.project import Project
    user = customer()
    project = Project(id=uuid.uuid4(), name='Fortea', created_by=user.id)
    mock_db.order_by.return_value = mock_db
    mock_db.first.return_value = project
    result = service.ensure_customer_workspace(mock_db, user, 'Different display name')
    assert result is project and result.name == 'Fortea'
    mock_db.add.assert_not_called()
    assert 'created_by' in str(mock_db.filter.call_args_list[-1].args[0])
    assert 'deleted_at' in str(mock_db.filter.call_args_list[-1].args[1])
    mock_db.with_for_update.assert_called_once()


def test_workspace_creation_uses_verified_name_and_private_identity(mock_db):
    from apps.api.models.project import Project, ProjectMember
    user = customer()
    mock_db.order_by.return_value = mock_db
    project = service.ensure_customer_workspace(mock_db, user, '  Fortea  ')
    assert project.name == 'Fortea' and project.created_by == user.id
    assert project.is_public is False
    member = next(c.args[0] for c in mock_db.add.call_args_list if isinstance(c.args[0], ProjectMember))
    assert member.user_id == user.id


def test_exchange_brand_name_is_display_only_and_not_read_from_jwt(monkeypatch):
    stub_suite(monkeypatch, owner_token=token(brandName='Untrusted claim name'))
    whop = jwt.encode({'aud': 'app_review', 'exp': int(time.time()) + 60}, 'test', algorithm='HS256')
    assert service.exchange_whop_token(whop).brand_name == 'My brand'


def test_whop_docx_request_works_when_proxy_removes_authorization(client, mock_db, monkeypatch, redis):
    from types import SimpleNamespace
    from apps.api.middleware import auth
    from apps.api.models.project import Project
    from apps.api.routers import requests as routes
    from apps.api.tests.test_briefing_docx import docx
    user = customer()
    mock_db.first.return_value = user
    stub_suite(monkeypatch)
    whop = jwt.encode({'aud': 'app_review', 'exp': int(time.time()) + 60}, 'test', algorithm='HS256')
    signed_in = client.post('/auth/whop', headers={'x-whop-user-token': whop})
    assert signed_in.status_code == 200
    monkeypatch.setattr(auth, 'get_user_by_id', lambda *args: user)
    project = Project(id=uuid.uuid4(), created_by=user.id, name='Fortea')
    mock_db.first.return_value = project
    mock_db.populate_existing.return_value = mock_db
    mock_db.with_for_update.return_value = mock_db
    monkeypatch.setattr(routes, 'require_project_role', lambda *a: None)
    monkeypatch.setattr(routes, 'project_brand', lambda *a: 'cust-owned')
    monkeypatch.setattr(routes, '_request_out', lambda req, *a, **kw: {'excerpt': req.brief_excerpt})
    binding = MagicMock(return_value=SimpleNamespace(id=uuid.uuid4(), request_id=None))
    monkeypatch.setattr(routes, 'reserve_binding', binding)
    monkeypatch.setattr(routes, 'dispatch_binding', lambda *a: None)
    result = client.post('/requests', headers={'X-FreeFrame-Token': signed_in.json()['access_token']},
                         json={'project_id': str(project.id), 'title': 'Launch', 'brief_docx_base64': docx()})
    assert result.status_code == 201, result.text
    assert result.json()['excerpt'].startswith('Launch brief')
    assert binding.call_args.args[4]['brief_text'].startswith('Launch brief')
