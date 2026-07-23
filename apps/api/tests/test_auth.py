"""
Auth endpoint tests.

The DB is fully mocked; we control what `query().filter().first()` returns
to simulate existing / non-existing users.

Password hashing (passlib/bcrypt) is mocked because the local environment has
a bcrypt version that is incompatible with passlib. The hash/verify logic is
unit-tested separately in test_auth_service.py.
"""
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from apps.api.models.user import UserStatus


_FAKE_HASH = "$2b$12$fakehashforteststhatisnotrealatall00000000000000000000"


def _mock_user(
    email: str = "test@example.com",
    password_hash: str = _FAKE_HASH,
) -> MagicMock:
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = email
    u.name = "Test User"
    u.password_hash = password_hash
    u.status = UserStatus.active
    u.avatar_url = None
    u.created_at = datetime.now(timezone.utc)
    u.deleted_at = None
    return u


# Patch bcrypt verification so tests don't depend on the local bcrypt installation.
_VERIFY_PATCH = "apps.api.routers.auth.verify_password"


def test_login_success(client, mock_db):
    """POST /auth/login — happy path returns access_token."""
    user = _mock_user("login@example.com")
    mock_db.first.return_value = user

    with patch(_VERIFY_PATCH, return_value=True):
        resp = client.post(
            "/auth/login",
            json={"email": "login@example.com", "password": "pw123456"},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert "access_token" in data
    assert "refresh_token" in data


def test_login_wrong_password(client, mock_db):
    """POST /auth/login — 401 on wrong password."""
    user = _mock_user("wp@example.com")
    mock_db.first.return_value = user

    with patch(_VERIFY_PATCH, return_value=False):
        resp = client.post(
            "/auth/login",
            json={"email": "wp@example.com", "password": "wrong"},
        )

    assert resp.status_code == 401


def test_login_nonexistent_user(client, mock_db):
    """POST /auth/login — 401 when user not found."""
    mock_db.first.return_value = None

    resp = client.post(
        "/auth/login",
        json={"email": "nobody@example.com", "password": "anypassword"},
    )
    assert resp.status_code == 401


def test_send_magic_code_unknown_email_does_not_create_user(client, mock_db):
    """POST /auth/send-magic-code — unknown email gets a generic response; no account is created.

    Regression test: this endpoint used to auto-create and later auto-activate an account for
    any email, bypassing the /users/invite gate entirely (GHSA-9m78-fww2-p89h).
    """
    mock_db.first.return_value = None  # no existing (i.e. no invited) user for this email

    with patch("apps.api.middleware.rate_limit.check_rate_limit", return_value=(True, 0)):
        resp = client.post("/auth/send-magic-code", json={"email": "uninvited@example.com"})

    assert resp.status_code == 200
    assert resp.json()["email"] == "uninvited@example.com"
    mock_db.add.assert_not_called()
    mock_db.commit.assert_not_called()


def test_send_magic_code_existing_user_sends_code(client, mock_db):
    """POST /auth/send-magic-code — an existing (e.g. already-invited) user gets a real code issued."""
    user = _mock_user("invited@example.com")
    mock_db.first.return_value = user

    with patch("apps.api.middleware.rate_limit.check_rate_limit", return_value=(True, 0)), \
         patch("apps.api.routers.auth.store_magic_code") as mock_store, \
         patch("apps.api.routers.auth.send_task_safe") as mock_send:
        resp = client.post("/auth/send-magic-code", json={"email": "invited@example.com"})

    assert resp.status_code == 200
    mock_store.assert_called_once()
    mock_send.assert_called_once()


def test_register_endpoint_removed(client):
    """POST /auth/register — endpoint has been removed (was an unauthenticated, un-invite-gated
    account creation path; GHSA-9m78-fww2-p89h). 404, not 405: the route no longer exists."""
    resp = client.post(
        "/auth/register",
        json={"email": "newuser@example.com", "name": "New User", "password": "securepassword"},
    )
    assert resp.status_code == 404


def test_users_batch_does_not_leak_invite_token(client, auth_headers, mock_db, test_user):
    """GET /users — never includes invite_token, even for a caller with no admin rights.

    Regression test: GET /users and GET /users/search reused UserResponse (which included
    invite_token) behind only get_current_user, so any authenticated user could read a
    pending invitee's live token and hijack the invite via /auth/accept-invite before the
    real invitee acted (GHSA-9m78-fww2-p89h).
    """
    test_user.is_superadmin = False
    target = _mock_user("invitee@example.com")
    target.status = UserStatus.pending_invite
    target.is_superadmin = False
    target.email_verified = False
    target.preferences = {}
    target.invite_token = "super-secret-invite-token"
    mock_db.all.return_value = [target]

    resp = client.get(f"/users?ids={target.id}", headers=auth_headers)

    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert "invite_token" not in body[0]


def test_admin_list_users_still_includes_invite_token(client, auth_headers, mock_db, test_user):
    """GET /admin/users — admin-gated, so it may still expose invite_token (needed for the
    admin "copy invite link" UI); this endpoint's own is_superadmin check is the gate."""
    test_user.is_superadmin = True
    target = _mock_user("invitee@example.com")
    target.status = UserStatus.pending_invite
    target.is_superadmin = False
    target.email_verified = False
    target.preferences = {}
    target.invite_token = "super-secret-invite-token"
    mock_db.all.return_value = [target]

    resp = client.get("/admin/users", headers=auth_headers)

    assert resp.status_code == 200
    body = resp.json()
    assert body[0]["invite_token"] == "super-secret-invite-token"


def test_get_me(client, auth_headers, test_user):
    """GET /auth/me — returns current user profile."""
    resp = client.get("/auth/me", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["email"] == test_user.email


def test_refresh_token(client, mock_db):
    """POST /auth/refresh — valid refresh token returns new access_token."""
    from apps.api.services.auth_service import create_refresh_token

    user = _mock_user("ref@example.com")
    refresh = create_refresh_token(str(user.id))
    mock_db.first.return_value = user

    resp = client.post("/auth/refresh", json={"refresh_token": refresh})
    assert resp.status_code == 200
    assert "access_token" in resp.json()


def test_refresh_token_invalid(client, mock_db):
    """POST /auth/refresh — bad token returns 401."""
    resp = client.post("/auth/refresh", json={"refresh_token": "not-a-valid-token"})
    assert resp.status_code == 401


def test_get_me_no_auth(client):
    """GET /auth/me without token should return 401 or 403 (no bearer scheme)."""
    resp = client.get("/auth/me")
    assert resp.status_code in (401, 403)
