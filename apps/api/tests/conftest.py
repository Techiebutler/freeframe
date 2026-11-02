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
    u.avatar_color = None
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


@pytest.fixture(autouse=True)
def _bypass_setup_guard(monkeypatch):
    """Mark initial setup complete so SetupGuardMiddleware doesn't 503 auth-gated client tests.
    The middleware caches a module-level `_setup_complete` flag checked against the REAL DB (its own
    SessionLocal, ignoring the get_db override); a fresh CI DB has no superadmin, so without this every
    client request 503s (masked only by the >=40 floor). No test asserts the needs_setup/503 path, so a
    blanket bypass is safe; monkeypatch restores the flag after each test."""
    monkeypatch.setattr("apps.api.middleware.setup_guard._setup_complete", True)


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

# ── real-Postgres harness for the storage and admin panel tests ───────────────
#
# A grouped SUM over joins is the feature in those files and the mock session
# cannot execute one. Shared harness: a real session whose commit stays inside
# the test's transaction, a way to sign somebody in against it, a row factory,
# and the panel helpers each of those files would otherwise copy.

@pytest.fixture
def live_db(real_db, monkeypatch):
    """`real_db` whose `commit()` is a flush, so endpoint writes stay in the
    test's transaction and are rolled back with it."""
    monkeypatch.setattr(real_db, "commit", real_db.flush)
    return real_db


@pytest.fixture
def as_user(live_db):
    """Sign a user in against `live_db` and hand back a TestClient for them."""
    from fastapi.testclient import TestClient
    from apps.api.database import get_db
    from apps.api.middleware.auth import get_current_user

    with patch("apps.api.services.s3_service.ensure_bucket_exists"), \
         patch("apps.api.services.s3_service.get_s3_client", return_value=MagicMock()):
        from apps.api.main import app

        def _sign_in(user):
            app.dependency_overrides[get_db] = lambda: live_db
            app.dependency_overrides[get_current_user] = lambda: user
            return TestClient(app, raise_server_exceptions=False)

        yield _sign_in
        app.dependency_overrides.clear()


class MediaSeed:
    """Factories for the rows the storage and admin panel tests measure."""

    def __init__(self, db):
        self.db = db

    def user(self, superadmin=False, name="person", deleted=False):
        from apps.api.models.user import User
        u = User(
            email=f"seed-{uuid.uuid4()}@test.local", name=name, is_superadmin=superadmin,
            deleted_at=datetime.now(timezone.utc) if deleted else None,
        )
        self.db.add(u)
        self.db.flush()
        return u

    def project(self, owner, name="theirs", deleted=False, members=True, public=False):
        from apps.api.models.project import Project, ProjectMember, ProjectRole, ProjectType
        p = Project(
            name=name, project_type=ProjectType.personal, created_by=owner.id, is_public=public,
            deleted_at=datetime.now(timezone.utc) if deleted else None,
        )
        self.db.add(p)
        self.db.flush()
        if members:
            self.db.add(ProjectMember(project_id=p.id, user_id=owner.id, role=ProjectRole.owner))
            self.db.flush()
        return p

    def member(self, project, user, role=None):
        from apps.api.models.project import ProjectMember, ProjectRole
        m = ProjectMember(
            project_id=project.id, user_id=user.id, role=role or ProjectRole.viewer,
        )
        self.db.add(m)
        self.db.flush()
        return m

    def asset(self, project, owner, name="clip", deleted=False):
        from apps.api.models.asset import Asset, AssetType
        a = Asset(
            project_id=project.id, name=name, asset_type=AssetType.video, created_by=owner.id,
            deleted_at=datetime.now(timezone.utc) if deleted else None,
        )
        self.db.add(a)
        self.db.flush()
        return a

    def version(
        self, asset, owner, number=1, original=1_000, derived: int | None = 0,
        status=None, filename=None, deleted=False, s3_keys=False,
    ):
        """One version of `asset` plus the media file that carries its bytes."""
        from apps.api.models.asset import (
            AssetVersion, FileType, MediaFile, ProcessingStatus,
        )
        v = AssetVersion(
            asset_id=asset.id, version_number=number,
            processing_status=status or ProcessingStatus.ready, created_by=owner.id,
            deleted_at=datetime.now(timezone.utc) if deleted else None,
        )
        self.db.add(v)
        self.db.flush()
        extra = {}
        if s3_keys:
            extra = {
                "s3_key_processed": f"processed/{v.id}/",
                "s3_key_thumbnail": f"processed/{v.id}/poster.jpg",
            }
        mf = MediaFile(
            version_id=v.id, file_type=FileType.video,
            original_filename=filename or f"v{number}.mp4", mime_type="video/mp4",
            file_size_bytes=original, s3_key_raw=f"raw/{v.id}",
            derived_size_bytes=derived, **extra,
        )
        self.db.add(mf)
        self.db.flush()
        return v, mf

    def media(
        self, project, owner, name="clip", versions=1, original=1_000,
        derived: int | None = 0, s3_keys=True,
    ):
        """An asset holding `versions` ready versions of the given size each."""
        a = self.asset(project, owner, name=name)
        for n in range(1, versions + 1):
            self.version(a, owner, number=n, original=original, derived=derived,
                         filename=f"{name}-v{n}.mp4", s3_keys=s3_keys)
        return a

    def versions_of(self, asset):
        """Every version row of `asset`, oldest first."""
        from apps.api.models.asset import AssetVersion
        return (
            self.db.query(AssetVersion)
            .filter(AssetVersion.asset_id == asset.id)
            .order_by(AssetVersion.version_number)
            .all()
        )

    def limit(self, cap: int) -> None:
        """Set the instance storage cap the upload guard enforces."""
        from apps.api.models.instance_settings import InstanceSettings
        row = self.db.query(InstanceSettings).first()
        if row is None:
            self.db.add(InstanceSettings(storage_limit_bytes=cap))
        else:
            row.storage_limit_bytes = cap
        self.db.flush()

    def trash(self, *rows) -> None:
        """Soft-delete anything already seeded."""
        for row in rows:
            row.deleted_at = datetime.now(timezone.utc)
        self.db.flush()


@pytest.fixture
def seed(live_db):
    """Row factory bound to `live_db`; see `MediaSeed`."""
    return MediaSeed(live_db)


@pytest.fixture
def admin(seed):
    """The one superadmin the panel tests sign in as."""
    return seed.user(superadmin=True, name="Ada Admin")


@pytest.fixture
def s3(monkeypatch):
    """Record every object-store call the purge cascade makes, patched on
    `tasks.cleanup_tasks`, which is where the cascade reaches for them."""
    calls = {"delete_object": [], "delete_prefix": [], "abort": []}
    import apps.api.tasks.cleanup_tasks as ct
    monkeypatch.setattr(ct, "delete_object", lambda k: calls["delete_object"].append(k))
    monkeypatch.setattr(ct, "delete_prefix", lambda k: calls["delete_prefix"].append(k))
    monkeypatch.setattr(ct, "abort_multipart_upload", lambda k, u: calls["abort"].append(k))
    return calls


class _Panel:
    """The two panel reads the delete and purge tests quote their figures from."""

    @staticmethod
    def summary(client):
        return client.get("/admin/storage").json()["summary"]

    @staticmethod
    def trash_counts(client):
        """The count and byte figures the purge dialog would echo back."""
        body = client.get("/admin/trash").json()
        return {
            "confirm_count": len(body["projects"]) + len(body["assets"]) + len(body["versions"]),
            "confirm_bytes": body["total_bytes"],
        }


@pytest.fixture
def panel():
    return _Panel()
