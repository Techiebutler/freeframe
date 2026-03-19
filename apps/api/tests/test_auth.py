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


# Patch bcrypt hashing so tests don't depend on the local bcrypt installation.
_HASH_PATCH = "apps.api.routers.auth.hash_password"
_VERIFY_PATCH = "apps.api.routers.auth.verify_password"


def test_register_success(client, mock_db):
    """POST /auth/register — happy path creates a user and returns 201."""
    mock_db.first.return_value = None  # no duplicate email

    def _refresh_side_effect(obj):
        obj.id = uuid.uuid4()
        obj.created_at = datetime.now(timezone.utc)
        obj.deleted_at = None
        obj.avatar_url = None
        obj.status = UserStatus.active
        obj.is_superadmin = False
        obj.email_verified = False

    mock_db.refresh.side_effect = _refresh_side_effect

    with patch(_HASH_PATCH, return_value=_FAKE_HASH):
        resp = client.post(
            "/auth/register",
            json={"email": "newuser@example.com", "name": "New User", "password": "securepassword"},
        )

    assert resp.status_code == 201
    assert resp.json()["email"] == "newuser@example.com"


def test_register_duplicate_email(client, mock_db):
    """POST /auth/register — returns 400 when email already exists."""
    existing = _mock_user("dup@example.com")
    mock_db.first.return_value = existing

    with patch(_HASH_PATCH, return_value=_FAKE_HASH):
        resp = client.post(
            "/auth/register",
            json={"email": "dup@example.com", "name": "A", "password": "pw123456"},
        )

    assert resp.status_code == 400


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
