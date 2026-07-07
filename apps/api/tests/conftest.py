"""
Test configuration for FreeFrame API.

Uses a mock-based database approach because the models use PostgreSQL-specific
UUID types that are incompatible with SQLite. All DB interactions are mocked
so tests can run without a live database or S3.
"""
import os
import sys
import uuid
import pytest
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock
from sqlalchemy.orm import Session as _SASession

# Set required environment variables BEFORE importing the app modules.
# This must happen before any import of apps.api.config or apps.api.main.
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@localhost:5432/freeframe_test")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
os.environ.setdefault("S3_BUCKET", "freeframe-test")
os.environ.setdefault("S3_ENDPOINT", "http://localhost:9000")
os.environ.setdefault("S3_ACCESS_KEY", "testkey")
os.environ.setdefault("S3_SECRET_KEY", "testsecret")
os.environ.setdefault("S3_REGION", "us-east-1")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-key-for-tests-only")
os.environ.setdefault("FRONTEND_URL", "http://localhost:3000")


_FAKE_HASH = "$2b$12$fakehashfortestsonlythisisnotrealatall000000000000000"


def _make_user(
    user_id: uuid.UUID | None = None,
    email: str = "test@example.com",
    name: str = "Test User",
    password: str = "testpassword123",
) -> MagicMock:
    """Create a mock User object.

    We use a fake password hash so this function works even when the local
    bcrypt installation is incompatible with passlib.
    """
    from apps.api.models.user import UserStatus

    u = MagicMock()
    u.id = user_id or uuid.uuid4()
    u.email = email
    u.name = name
    # Store a fake hash — tests that need verify() must mock it themselves.
    u.password_hash = _FAKE_HASH
    u.status = UserStatus.active
    u.avatar_url = None
    u.created_at = datetime.now(timezone.utc)
    u.deleted_at = None
    u.is_superadmin = False
    u.email_verified = False
    u.preferences = {}
    u.invite_token = None
    return u


def _make_mock_db() -> MagicMock:
    """Return a fresh mock Session."""
    db = MagicMock()
    db.query.return_value = db
    db.filter.return_value = db
    db.first.return_value = None
    db.all.return_value = []
    db.add.return_value = None
    db.flush.return_value = None
    db.commit.return_value = None
    db.refresh.return_value = None
    db.close.return_value = None
    return db


@pytest.fixture
def mock_db():
    """Provide a fresh mock DB session for each test."""
    return _make_mock_db()


@pytest.fixture
def client(mock_db):
    """Return a TestClient with mocked DB and S3."""
    with patch("apps.api.services.s3_service.ensure_bucket_exists"):
        with patch("apps.api.services.s3_service.get_s3_client", return_value=MagicMock()):
            from fastapi.testclient import TestClient
            from apps.api.main import app
            from apps.api.database import get_db

            app.dependency_overrides[get_db] = lambda: mock_db
            client = TestClient(app, raise_server_exceptions=False)
            yield client
            app.dependency_overrides.clear()


@pytest.fixture
def test_user(mock_db):
    """A mock user for use in auth-dependent tests."""
    return _make_user()


@pytest.fixture
def auth_headers(client, mock_db, test_user):
    """
    Simulate auth by:
    1. Patching get_user_by_email to return None on first call (no existing user)
       then the new user on subsequent calls.
    2. Letting the real hash/verify/JWT logic run.
    3. Returning Bearer headers.
    """
    from apps.api.services.auth_service import create_access_token, create_refresh_token
    # Directly generate a valid token for the test user
    token = create_access_token(str(test_user.id))

    # Make get_current_user resolve to test_user
    from apps.api.middleware.auth import get_current_user
    from apps.api.main import app

    app.dependency_overrides[get_current_user] = lambda: test_user
    yield {"Authorization": f"Bearer {token}"}
    # Cleanup: remove get_current_user override but keep get_db override
    app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture
def real_db():
    """Real-Postgres session inside a transaction that is always rolled back (no writes persist).

    For code that mutates but does not commit — commit is exercised by the Celery task wrapper,
    not here, so the outer rollback fully cleans up.
    """
    from apps.api.database import engine
    conn = engine.connect()
    trans = conn.begin()
    session = _SASession(bind=conn)
    try:
        yield session
    finally:
        session.close()
        trans.rollback()
        conn.close()
