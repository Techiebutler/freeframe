"""Avatar paths beyond the user's own: a superadmin acting for someone else,
removing a stored value that isn't the user's upload, and deleting a user.

Every delete goes through `delete_own_avatar`, so an object is only removed
when the stored key is that user's own uploaded avatar.
"""
from unittest.mock import patch

import pytest

from apps.api.models.user import UserStatus
from apps.api.tests.conftest import _make_user

S3 = "apps.api.routers.users.s3_service"


@pytest.fixture
def admin(test_user):
    test_user.is_superadmin = True
    return test_user


@pytest.fixture
def bob(mock_db):
    """The other user every lookup resolves to."""
    u = _make_user(email="bob@example.com", name="Bob")
    mock_db.first.return_value = u
    return u


@pytest.fixture
def presign_get():
    with patch(
        "apps.api.services.s3_service.generate_presigned_get_url",
        side_effect=lambda key, *a, **kw: f"https://s3.test/{key}",
    ) as m:
        yield m


# ── a superadmin acting for another user ──────────────────────────────────────

def test_a_superadmin_can_sign_an_upload_for_another_user(client, admin, bob, auth_headers):
    with patch(f"{S3}.generate_presigned_put_url", return_value="https://put") as put:
        resp = client.post(f"/users/{bob.id}/avatar-upload?content_type=image/webp", headers=auth_headers)

    assert resp.status_code == 201
    # Under the target's prefix, not the admin's.
    assert resp.json()["key"].startswith(f"avatars/{bob.id}/")
    put.assert_called_once()


def test_a_superadmin_can_confirm_another_users_avatar(client, admin, bob, auth_headers, presign_get):
    key = f"avatars/{bob.id}/new.webp"
    with patch(f"{S3}.head_object_size", return_value=20_000):
        resp = client.post(f"/users/{bob.id}/avatar-confirm", json={"key": key}, headers=auth_headers)

    assert resp.status_code == 200
    assert bob.avatar_url == key


def test_a_superadmin_cannot_give_another_user_the_admins_own_key(client, admin, bob, auth_headers):
    """The key must be the target's own, whoever is asking."""
    key = f"avatars/{admin.id}/mine.webp"
    with patch(f"{S3}.head_object_size") as head:
        resp = client.post(f"/users/{bob.id}/avatar-confirm", json={"key": key}, headers=auth_headers)

    assert resp.status_code == 400
    head.assert_not_called()
    assert bob.avatar_url is None


def test_a_superadmin_can_remove_another_users_avatar(client, admin, bob, auth_headers):
    old = f"avatars/{bob.id}/old.webp"
    bob.avatar_url = old

    with patch(f"{S3}.delete_object") as delete:
        resp = client.delete(f"/users/{bob.id}/avatar", headers=auth_headers)

    assert resp.status_code == 200
    assert bob.avatar_url is None
    delete.assert_called_once_with(old)


# ── a stored value that isn't the user's own ──────────────────────────────────

@pytest.mark.parametrize("stored", [
    "raw/other-project/asset/version/original.mp4",
    "avatars/00000000-0000-0000-0000-000000000000/x.png",
    "https://tracker.example/p.gif",
])
def test_removing_clears_a_foreign_value_without_deleting_it(client, mock_db, test_user, auth_headers, stored):
    mock_db.first.return_value = test_user
    test_user.avatar_url = stored

    with patch(f"{S3}.delete_object") as delete:
        resp = client.delete(f"/users/{test_user.id}/avatar", headers=auth_headers)

    assert resp.status_code == 200
    assert test_user.avatar_url is None
    delete.assert_not_called()


# ── deleting a user ───────────────────────────────────────────────────────────

def test_deleting_a_user_clears_and_reclaims_their_picture(client, mock_db, admin, bob, auth_headers):
    old = f"avatars/{bob.id}/pic.webp"
    bob.avatar_url = old
    bob.status = UserStatus.deactivated
    events = []
    mock_db.commit.side_effect = lambda: events.append(("commit", bob.avatar_url))

    with patch(f"{S3}.delete_object", side_effect=lambda k: events.append(("delete", k))):
        resp = client.delete(f"/users/{bob.id}", headers=auth_headers)

    assert resp.status_code == 204
    assert bob.deleted_at is not None
    # Cleared in the same commit as the delete, and removed only after it.
    assert events == [("commit", None), ("delete", old)]


def test_deleting_a_user_never_deletes_a_foreign_stored_value(client, mock_db, admin, bob, auth_headers):
    bob.avatar_url = "raw/other-project/asset/version/original.mp4"
    bob.status = UserStatus.deactivated

    with patch(f"{S3}.delete_object") as delete:
        resp = client.delete(f"/users/{bob.id}", headers=auth_headers)

    assert resp.status_code == 204
    assert bob.avatar_url is None
    delete.assert_not_called()
