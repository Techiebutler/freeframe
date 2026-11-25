"""HTTP contract for the opt-in browser refresh cookie."""
from http.cookies import SimpleCookie
from unittest.mock import patch

import pytest

from apps.api.models.user import UserStatus
from apps.api.services.auth_service import create_access_token, create_refresh_token, decode_token

WEB = {"X-FF-Client": "web", "Sec-Fetch-Site": "same-origin"}
FOREIGN_ORIGIN = {"Origin": "https://other.example"}
FOREIGN_WEB = {"X-FF-Client": "web", **FOREIGN_ORIGIN}
LOGIN = {"email": "test@example.com", "password": "fixture-password"}
HOST = "__Host-ff_refresh_token"
LEGACY = "ff_refresh_token"


@pytest.fixture
def valid_refresh(mock_db, test_user):
    test_user.token_version = 1
    mock_db.first.return_value = test_user
    return create_refresh_token(str(test_user.id))


def cookies(response):
    result = SimpleCookie()
    for value in response.headers.get_list("set-cookie"):
        result.load(value)
    return result


@pytest.mark.parametrize("route, method, payload, target", [
    ("/auth/login", "POST", {"email": "test@example.com", "password": "fixture-password"}, "verify_password"),
    ("/auth/verify-magic-code", "POST", {"email": "test@example.com", "code": "123456"}, "redis_verify_magic_code"),
    ("/auth/accept-invite", "POST", {"token": "fixture", "name": "Reviewer", "password": "fixture-password"}, "hash_password"),
    ("/auth/change-password", "PATCH", {"current_password": "fixture-password", "new_password": "new-fixture"}, "verify_password"),
])
def test_web_auth_issues_host_cookie(client, test_user, valid_refresh, route, method, payload, target):
    test_user.invite_token_expires_at = None
    with patch(f"apps.api.routers.auth.{target}", return_value=(True, None) if target == "redis_verify_magic_code" else "test-hash"):
        if method == "PATCH":
            from apps.api.services.auth_service import create_access_token
            headers = {**WEB, "Authorization": f"Bearer {create_access_token(str(test_user.id))}"}
        else:
            headers = WEB
        response = client.request(method, route, json=payload, headers=headers)
    assert response.status_code == 200
    assert "refresh_token" not in response.json()
    cookie = cookies(response)[HOST]
    assert decode_token(cookie.value)["type"] == "refresh"
    assert cookie["httponly"] and cookie["secure"]
    assert cookie["samesite"] == "lax" and cookie["path"] == "/" and not cookie["domain"]


def test_browser_first_setup_issues_cookie(client, mock_db):
    from uuid import uuid4

    mock_db.refresh.side_effect = lambda user: setattr(user, "id", uuid4())
    with patch("apps.api.routers.setup.get_email_owner", return_value=None):
        response = client.post("/setup/create-superadmin", json={
            "email": "test@example.com", "name": "Reviewer", "password": "fixture-password",
        }, headers=WEB)
    assert response.status_code == 201
    assert "refresh_token" not in response.json()
    assert decode_token(cookies(response)[HOST].value)["type"] == "refresh"


def test_foreign_web_login_issues_no_session(client, valid_refresh):
    with patch("apps.api.routers.auth.verify_password", return_value=True), \
         patch("apps.api.routers.auth.create_access_token", wraps=create_access_token) as access, \
         patch("apps.api.routers.auth.create_refresh_token", wraps=create_refresh_token) as refresh:
        response = client.post("/auth/login", json=LOGIN, headers=FOREIGN_WEB)
    assert response.status_code == 403
    assert "set-cookie" not in response.headers
    access.assert_not_called()
    refresh.assert_not_called()


def test_foreign_login_without_web_header_uses_body_tokens(client, valid_refresh):
    with patch("apps.api.routers.auth.verify_password", return_value=True):
        response = client.post("/auth/login", json=LOGIN, headers=FOREIGN_ORIGIN)
    assert response.status_code == 200
    payload = decode_token(response.json()["refresh_token"])
    assert payload and payload["type"] == "refresh"
    assert "set-cookie" not in response.headers


def test_foreign_web_accept_invite_leaves_invite_unspent(client, mock_db, test_user, valid_refresh):
    test_user.invite_token = "fixture"
    test_user.invite_token_expires_at = None
    test_user.status = UserStatus.pending_invite
    with patch("apps.api.routers.auth.hash_password", return_value="test-hash"):
        response = client.post("/auth/accept-invite", json={
            "token": "fixture", "name": "Reviewer", "password": "fixture-password",
        }, headers=FOREIGN_WEB)
    assert response.status_code == 403
    assert test_user.invite_token == "fixture"
    assert test_user.status == UserStatus.pending_invite
    mock_db.commit.assert_not_called()


def test_foreign_web_verify_magic_code_leaves_code_unspent(client, mock_db, test_user, valid_refresh):
    from apps.api.services.redis_service import MAGIC_CODE_PREFIX

    code_key = f"{MAGIC_CODE_PREFIX}{test_user.id}"
    stored = {code_key: "123456"}
    with patch("apps.api.services.redis_service.get_redis") as get_redis:
        redis = get_redis.return_value
        redis.get.side_effect = stored.get
        redis.delete.side_effect = lambda key: stored.pop(key, None)
        response = client.post("/auth/verify-magic-code", json={
            "email": LOGIN["email"], "code": "123456",
        }, headers=FOREIGN_WEB)
    assert response.status_code == 403
    assert stored == {code_key: "123456"}
    assert test_user.email_verified is False
    mock_db.commit.assert_not_called()


def test_foreign_web_change_password_leaves_password_unchanged(client, mock_db, test_user, valid_refresh):
    old_hash = test_user.password_hash
    headers = {**FOREIGN_WEB, "Authorization": f"Bearer {create_access_token(str(test_user.id))}"}
    with patch("apps.api.routers.auth.verify_password", return_value=True), \
         patch("apps.api.routers.auth.hash_password", return_value="new-hash"):
        response = client.patch("/auth/change-password", json={
            "current_password": "fixture-password", "new_password": "new-fixture",
        }, headers=headers)
    assert response.status_code == 403
    assert test_user.password_hash == old_hash
    assert test_user.token_version == 1
    mock_db.commit.assert_not_called()


def test_foreign_web_setup_does_not_create_superadmin(client, mock_db):
    from uuid import uuid4

    mock_db.refresh.side_effect = lambda user: setattr(user, "id", uuid4())
    with patch("apps.api.routers.setup.get_email_owner", return_value=None), \
         patch("apps.api.routers.setup.hash_password", return_value="test-hash"):
        response = client.post("/setup/create-superadmin", json={
            **LOGIN, "name": "Reviewer",
        }, headers=FOREIGN_WEB)
    assert response.status_code == 403
    assert response.json()["detail"] == "Cross-origin request rejected"
    mock_db.add.assert_not_called()
    mock_db.commit.assert_not_called()


@pytest.mark.parametrize("source", [HOST, LEGACY, "body"])
def test_web_refresh_accepts_current_cookie_or_migrates_legacy_token(client, valid_refresh, source):
    kwargs = ({"json": {"refresh_token": valid_refresh}} if source == "body"
              else {"headers": {**WEB, "Cookie": f"{source}={valid_refresh}"}})
    response = client.post("/auth/refresh", **({"headers": WEB} | kwargs))
    if source == LEGACY:
        assert response.status_code == 401
        return
    assert response.status_code == 200
    assert "refresh_token" not in response.json()
    assert HOST in cookies(response)
    assert cookies(response)[LEGACY]["max-age"] == "0"


@pytest.mark.parametrize("dead_source", [None, "cookie", "body"], ids=["both-live", "dead-cookie", "dead-body"])
def test_web_refresh_uses_first_live_credential(client, test_user, valid_refresh, dead_source):
    from uuid import uuid4

    from apps.api.models.user import User

    other_user = User(id=uuid4(), status=UserStatus.active, token_version=2)
    other_token = create_refresh_token(str(other_user.id), token_version=other_user.token_version)
    stale_other_token = create_refresh_token(str(other_user.id), token_version=1)
    body_token = stale_other_token if dead_source == "body" else valid_refresh
    cookie_token = stale_other_token if dead_source == "cookie" else other_token
    users = {test_user.id: test_user, other_user.id: other_user}
    with patch("apps.api.routers.auth.get_user_by_id", side_effect=lambda db, user_id: users.get(user_id)):
        response = client.post("/auth/refresh", json={"refresh_token": body_token},
                               headers={**WEB, "Cookie": f"{HOST}={cookie_token}"})
    assert response.status_code == 200
    expected = other_user if dead_source == "body" else test_user
    payload = decode_token(response.json()["access_token"])
    assert payload and payload["sub"] == str(expected.id)


def test_body_client_gets_body_token_even_with_an_unrelated_cookie(client, valid_refresh):
    response = client.post("/auth/refresh", json={"refresh_token": valid_refresh},
                           headers={"Cookie": f"{HOST}=invalid"})
    assert response.status_code == 200
    assert decode_token(response.json()["refresh_token"])["type"] == "refresh"
    assert "set-cookie" not in response.headers


def test_body_client_cannot_use_cookie(client, valid_refresh):
    response = client.post("/auth/refresh", headers={"Cookie": f"{HOST}={valid_refresh}"})
    assert response.status_code == 422


@pytest.mark.parametrize("site", ["cross-site", "same-site"])
@pytest.mark.parametrize("route", ["/auth/refresh", "/auth/logout"])
def test_cookie_endpoints_refuse_other_origins(client, valid_refresh, site, route):
    response = client.post(route, headers={**WEB, "Sec-Fetch-Site": site,
                                           "Cookie": f"{HOST}={valid_refresh}"})
    assert response.status_code == 403
    assert "set-cookie" not in response.headers


def test_logout_expires_both_cookies(client):
    response = client.post("/auth/logout", headers=WEB)
    assert response.status_code == 204
    expired = cookies(response)
    assert expired[HOST]["max-age"] == "0"
    assert expired[HOST]["secure"] and expired[HOST]["httponly"]
    assert expired[LEGACY]["max-age"] == "0"


def test_cookie_mode_has_its_own_refresh_limit(client, valid_refresh):
    with patch("apps.api.middleware.rate_limit.check_rate_limit", return_value=(True, 0)) as limit:
        for headers in (WEB, {}):
            client.post("/auth/refresh", json={"refresh_token": valid_refresh}, headers=headers)
    limits = {(call.args[1], call.args[2], call.args[3]) for call in limit.call_args_list}
    assert ("refresh_token_web", 120, 60) in limits
    assert ("refresh_token", 30, 60) in limits


def test_wildcard_cors_warns_without_refusing_startup(client, monkeypatch, caplog):
    from apps.api.config import settings
    from apps.api import main

    monkeypatch.setattr(settings, "cors_allow_origins", "*")
    with patch.object(main, "run_startup_bucket_setup"), client:
        assert client.get("/health").status_code == 200
    assert "CORS_ALLOW_ORIGINS=*" in caplog.text
