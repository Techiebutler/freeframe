"""Email addresses match regardless of case, without merging accounts (#471).

Addresses used to be stored as typed and compared exactly, so `Bob@` and `bob@`
were two users: an admin could invite either next to the other (or next to a
deleted one), and an account answered only to the exact case it was invited in.

Guarded here, against a real Postgres through the real app (MagicMock cannot
evaluate `func.lower`):
  * invite and setup refuse an address another row holds in any case, deleted
    rows included, with the existing messages;
  * new addresses are stored lowercase;
  * sign-in and the magic code find a legacy mixed-case account by any case;
  * on an instance that already holds two accounts differing only by case, each
    still answers to its exact address and an address matching both finds
    nobody, so no one lands in the other account;
  * a magic code belongs to the account it was sent to, so one of such a pair
    cannot verify the other's code.
"""
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

PASSWORD = "correct horse battery"
DELETED_DETAIL = "This email belonged to a deleted user and can't be invited again"


@pytest.fixture
def db():
    """A real session where each endpoint commit lands in a SAVEPOINT, so the
    app can commit and the outer transaction still rolls back."""
    from apps.api.database import engine

    conn = engine.connect()
    trans = conn.begin()
    session = Session(bind=conn, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        trans.rollback()
        conn.close()


class FakeRedis:
    """Just enough of redis for the magic-code helpers."""

    def __init__(self):
        self.data = {}

    def setex(self, key, ttl, value):
        self.data[key] = str(value)

    def get(self, key):
        return self.data.get(key)

    def delete(self, key):
        self.data.pop(key, None)

    def incr(self, key):
        self.data[key] = str(int(self.data.get(key, 0)) + 1)

    def expire(self, key, ttl):
        pass


@pytest.fixture
def client(db, monkeypatch):
    from fastapi.testclient import TestClient
    from apps.api.main import app
    from apps.api.database import get_db

    monkeypatch.setattr("apps.api.middleware.rate_limit.check_rate_limit", lambda *a, **k: (True, 0))
    fake_redis = FakeRedis()
    monkeypatch.setattr("apps.api.services.redis_service.get_redis", lambda: fake_redis)
    with patch("apps.api.services.s3_service.ensure_bucket_exists"):
        app.dependency_overrides[get_db] = lambda: db
        yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


@pytest.fixture
def domain():
    """A fresh domain per test, so rows from a concurrent run never collide."""
    return f"{uuid.uuid4().hex[:10]}.example.com"


def _user(db, email, **kw):
    from apps.api.models.user import User, UserStatus
    from apps.api.services.auth_service import hash_password

    kw.setdefault("password_hash", hash_password(PASSWORD))
    u = User(email=email, name=email.split("@")[0], status=UserStatus.active, **kw)
    db.add(u); db.flush(); db.refresh(u)
    return u


def _admin(db, domain):
    return _user(db, f"admin@{domain}", is_superadmin=True)


def _auth(user):
    from apps.api.services.auth_service import create_access_token
    return {"Authorization": f"Bearer {create_access_token(str(user.id), user.token_version or 1)}"}


def _rows(db, domain):
    from apps.api.models.user import User
    return sorted(
        u.email for u in db.query(User).filter(User.email.ilike(f"%@{domain}")).all()
        if not u.email.startswith("admin@")
    )


# ── Invite and setup ─────────────────────────────────────────────────────────

def test_invite_refuses_a_deleted_users_address_in_another_case(client, db, domain):
    admin = _admin(db, domain)
    with patch("apps.api.routers.users.send_task_safe"):
        first = client.post("/users/invite", json={"email": f"victim@{domain}", "name": "v"},
                            headers=_auth(admin))
        assert first.status_code == 201, first.text
        from apps.api.models.user import User
        db.query(User).filter(User.id == uuid.UUID(first.json()["id"])).update(
            {"deleted_at": datetime.now(timezone.utc)})
        db.flush()

        resp = client.post("/users/invite", json={"email": f"Victim@{domain}", "name": "v"},
                           headers=_auth(admin))

    assert resp.status_code == 400
    assert resp.json()["detail"] == DELETED_DETAIL
    assert _rows(db, domain) == [f"victim@{domain}"]


def test_invite_refuses_a_live_address_in_another_case(client, db, domain):
    admin = _admin(db, domain)
    _user(db, f"bob@{domain}")
    with patch("apps.api.routers.users.send_task_safe") as send:
        resp = client.post("/users/invite", json={"email": f"Bob@{domain}", "name": "b"},
                           headers=_auth(admin))

    assert resp.status_code == 400
    assert resp.json()["detail"] == "Email already registered"
    send.assert_not_called()
    assert _rows(db, domain) == [f"bob@{domain}"]


def test_invite_prefers_already_registered_when_a_live_and_a_deleted_row_match(client, db, domain):
    admin = _admin(db, domain)
    _user(db, f"bob@{domain}", deleted_at=datetime.now(timezone.utc))
    _user(db, f"Bob@{domain}")
    resp = client.post("/users/invite", json={"email": f"BOB@{domain}", "name": "b"},
                       headers=_auth(admin))

    assert resp.status_code == 400
    assert resp.json()["detail"] == "Email already registered"


def test_invite_stores_the_address_lowercase(client, db, domain):
    admin = _admin(db, domain)
    with patch("apps.api.routers.users.send_task_safe") as send:
        resp = client.post("/users/invite", json={"email": f"Carol.Smith@{domain}", "name": "c"},
                           headers=_auth(admin))

    assert resp.status_code == 201, resp.text
    assert resp.json()["email"] == f"carol.smith@{domain}"
    assert _rows(db, domain) == [f"carol.smith@{domain}"]
    assert send.call_args.args[1] == f"carol.smith@{domain}"


def test_setup_stores_the_address_lowercase(client, db, domain):
    with patch("apps.api.routers.setup._has_superadmin", return_value=False):
        resp = client.post("/setup/create-superadmin",
                           json={"email": f"Owner@{domain}", "name": "o", "password": PASSWORD})

    assert resp.status_code == 201, resp.text
    assert _rows(db, domain) == [f"owner@{domain}"]


@pytest.mark.parametrize("deleted", [False, True])
def test_setup_refuses_an_address_another_row_holds_in_any_case(client, db, domain, deleted):
    _user(db, f"owner@{domain}", deleted_at=datetime.now(timezone.utc) if deleted else None)
    with patch("apps.api.routers.setup._has_superadmin", return_value=False):
        resp = client.post("/setup/create-superadmin",
                           json={"email": f"Owner@{domain}", "name": "o", "password": PASSWORD})

    assert resp.status_code == 400
    assert resp.json()["detail"] == "Email already registered"
    assert _rows(db, domain) == [f"owner@{domain}"]


# ── Lookup ───────────────────────────────────────────────────────────────────

def test_password_login_finds_a_legacy_mixed_case_account_by_any_case(client, db, domain):
    legacy = _user(db, f"Bob.Jones@{domain}")
    for typed in (f"bob.jones@{domain}", f"BOB.JONES@{domain}", f"Bob.Jones@{domain}"):
        resp = client.post("/auth/login", json={"email": typed, "password": PASSWORD})
        assert resp.status_code == 200, (typed, resp.text)
        from apps.api.services.auth_service import decode_token
        assert decode_token(resp.json()["access_token"])["sub"] == str(legacy.id)


def test_two_accounts_differing_only_by_case_each_answer_to_their_exact_address(client, db, domain):
    from apps.api.services.auth_service import get_user_by_email

    upper = _user(db, f"Bob@{domain}")
    lower = _user(db, f"bob@{domain}")

    assert get_user_by_email(db, f"Bob@{domain}").id == upper.id
    assert get_user_by_email(db, f"bob@{domain}").id == lower.id
    assert get_user_by_email(db, f" bob@{domain} ").id == lower.id
    # Matches both and neither exactly: nobody, rather than a guess.
    assert get_user_by_email(db, f"BOB@{domain}") is None
    resp = client.post("/auth/login", json={"email": f"BOB@{domain}", "password": PASSWORD})
    assert resp.status_code == 401


def test_lookup_ignores_soft_deleted_rows(db, domain):
    from apps.api.services.auth_service import get_user_by_email

    _user(db, f"bob@{domain}", deleted_at=datetime.now(timezone.utc))
    live = _user(db, f"Bob@{domain}")

    # The exact match is deleted, so the one live case-insensitive match wins.
    assert get_user_by_email(db, f"bob@{domain}").id == live.id


# ── Magic code ───────────────────────────────────────────────────────────────

def test_magic_code_requested_in_another_case_reaches_and_signs_in_the_stored_account(client, db, domain):
    user = _user(db, f"bob@{domain}", password_hash=None)
    with patch("apps.api.routers.auth.send_task_safe") as send:
        sent = client.post("/auth/send-magic-code", json={"email": f"Bob@{domain}"})
        unknown = client.post("/auth/send-magic-code", json={"email": f"Nobody@{domain}"})

    assert sent.status_code == unknown.status_code == 200
    # Same shape for a known and an unknown address, echoing what was typed.
    assert sent.json() == {"message": "Magic code sent to your email", "email": f"Bob@{domain}"}
    assert unknown.json() == {"message": "Magic code sent to your email", "email": f"Nobody@{domain}"}
    send.assert_called_once()
    to, code = send.call_args.args[1], send.call_args.args[2]
    assert to == f"bob@{domain}"

    resp = client.post("/auth/verify-magic-code", json={"email": f"bob@{domain}", "code": code})
    assert resp.status_code == 200, resp.text
    from apps.api.services.auth_service import decode_token
    assert decode_token(resp.json()["access_token"])["sub"] == str(user.id)


def test_magic_code_of_one_case_twin_does_not_verify_the_other(client, db, domain):
    upper = _user(db, f"Bob@{domain}")
    _user(db, f"bob@{domain}")
    with patch("apps.api.routers.auth.send_task_safe") as send:
        client.post("/auth/send-magic-code", json={"email": f"Bob@{domain}"})
    to, code = send.call_args.args[1], send.call_args.args[2]
    assert to == f"Bob@{domain}"

    other = client.post("/auth/verify-magic-code", json={"email": f"bob@{domain}", "code": code})
    assert other.status_code == 401

    own = client.post("/auth/verify-magic-code", json={"email": f"Bob@{domain}", "code": code})
    assert own.status_code == 200, own.text
    from apps.api.services.auth_service import decode_token
    assert decode_token(own.json()["access_token"])["sub"] == str(upper.id)


# ── Non-ASCII case folding ───────────────────────────────────────────────────
# Postgres lower() and Python str.lower() disagree on some letters: lower('İ')
# is 'i' in Postgres but 'i' plus a combining dot in Python. Each comparison
# must fold both sides with the same function, or an address can miss itself.

def test_invite_refuses_a_legacy_non_ascii_address_typed_the_same(client, db, domain):
    admin = _admin(db, domain)
    _user(db, f"İvan@{domain}")
    with patch("apps.api.routers.users.send_task_safe") as send:
        resp = client.post("/users/invite", json={"email": f"İvan@{domain}", "name": "i"},
                           headers=_auth(admin))

    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "Email already registered"
    send.assert_not_called()
    assert _rows(db, domain) == [f"İvan@{domain}"]


def test_invite_refuses_a_non_ascii_address_it_already_invited(client, db, domain):
    admin = _admin(db, domain)
    with patch("apps.api.routers.users.send_task_safe"):
        first = client.post("/users/invite", json={"email": f"İvan@{domain}", "name": "i"},
                            headers=_auth(admin))
        again = client.post("/users/invite", json={"email": f"İVAN@{domain}", "name": "i"},
                            headers=_auth(admin))

    assert first.status_code == 201, first.text
    assert again.status_code == 400, again.text
    assert again.json()["detail"] == "Email already registered"
    assert len(_rows(db, domain)) == 1


def test_lookup_finds_a_legacy_non_ascii_account_in_another_case(db, domain):
    from apps.api.services.auth_service import get_user_by_email

    legacy = _user(db, f"İvan@{domain}")
    assert get_user_by_email(db, f"İVAN@{domain}").id == legacy.id
