"""Profile pictures and the avatar circle colour.

The avatar is an S3 key on `User.avatar_url` that every response presigns. That
makes the key itself the sensitive part: whatever a user can store there, they
can read back. So it is set only through avatar-confirm, which checks the key is
under the caller's own prefix; `PATCH /users/{id}` used to accept it too, with no
check at all, which let anyone read any object in the bucket.
"""
from unittest.mock import patch

import pytest

S3 = "apps.api.routers.users.s3_service"


@pytest.fixture
def me(mock_db, test_user):
    """Make the endpoint resolve `user_id` to the caller's own record."""
    mock_db.first.return_value = test_user
    return test_user


@pytest.fixture
def presign_get():
    with patch(
        "apps.api.services.s3_service.generate_presigned_get_url",
        side_effect=lambda key, *a, **kw: f"https://s3.test/{key}",
    ) as m:
        yield m


# ── Circle colour ──────────────────────────────────────────────────────────────

def test_a_colour_is_stored_lowercase_and_returned(client, me, auth_headers):
    resp = client.patch(f"/users/{me.id}", json={"avatar_color": "#A1B2C3"}, headers=auth_headers)

    assert resp.status_code == 200
    assert me.avatar_color == "#a1b2c3"
    assert resp.json()["avatar_color"] == "#a1b2c3"


@pytest.mark.parametrize("bad", ["red", "#fff", "a1b2c3", "#a1b2c3ff", "#gggggg"])
def test_a_colour_that_is_not_six_digit_hex_is_refused(client, me, auth_headers, bad):
    resp = client.patch(f"/users/{me.id}", json={"avatar_color": bad}, headers=auth_headers)

    assert resp.status_code == 422
    assert me.avatar_color is None


def test_an_explicit_null_resets_the_colour(client, me, auth_headers):
    me.avatar_color = "#112233"

    resp = client.patch(f"/users/{me.id}", json={"avatar_color": None}, headers=auth_headers)

    assert resp.status_code == 200
    assert me.avatar_color is None


def test_omitting_the_colour_leaves_it_alone(client, me, auth_headers):
    """This is a PATCH: saving the name must not wipe the colour."""
    me.avatar_color = "#112233"

    resp = client.patch(f"/users/{me.id}", json={"name": "New Name"}, headers=auth_headers)

    assert resp.status_code == 200
    assert me.avatar_color == "#112233"


def test_the_profile_patch_no_longer_sets_the_avatar_key(client, me, auth_headers, presign_get):
    """Regression: any key stored here was presigned straight back to the caller,
    so pointing it at another project's media handed out a download URL for it."""
    resp = client.patch(
        f"/users/{me.id}", json={"avatar_url": "raw/other-project/secret.mp4"},
        headers=auth_headers,
    )

    assert resp.status_code == 200
    assert me.avatar_url is None
    presign_get.assert_not_called()


# ── Upload URL ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("ctype,ext", [("image/png", "png"), ("image/jpeg", "jpg"), ("image/webp", "webp")])
def test_an_image_upload_is_signed_under_the_callers_prefix(client, me, auth_headers, ctype, ext):
    with patch(f"{S3}.generate_presigned_put_url", return_value="https://s3.test/put") as put:
        resp = client.post(
            f"/users/{me.id}/avatar-upload", params={"content_type": ctype}, headers=auth_headers,
        )

    assert resp.status_code == 201
    key = resp.json()["key"]
    assert key.startswith(f"avatars/{me.id}/") and key.endswith(f".{ext}")
    assert put.call_args.kwargs["content_type"] == ctype


@pytest.mark.parametrize("ctype", ["text/html", "image/svg+xml", "application/octet-stream"])
def test_a_non_image_upload_is_not_signed(client, me, auth_headers, ctype):
    """The object is served back with the type it was stored as, so signing
    text/html would put a page of the uploader's choosing on the bucket's origin."""
    with patch(f"{S3}.generate_presigned_put_url") as put:
        resp = client.post(
            f"/users/{me.id}/avatar-upload", params={"content_type": ctype}, headers=auth_headers,
        )

    assert resp.status_code == 400
    put.assert_not_called()


def test_uploading_for_someone_else_is_refused(client, me, auth_headers):
    import uuid

    with patch(f"{S3}.generate_presigned_put_url") as put:
        resp = client.post(f"/users/{uuid.uuid4()}/avatar-upload", headers=auth_headers)

    assert resp.status_code == 403
    put.assert_not_called()


# ── Confirm ────────────────────────────────────────────────────────────────────

def test_confirm_refuses_a_key_that_was_never_uploaded(client, me, auth_headers):
    key = f"avatars/{me.id}/never.webp"
    with patch(f"{S3}.head_object_size", return_value=None):
        resp = client.post(f"/users/{me.id}/avatar-confirm", json={"key": key}, headers=auth_headers)

    assert resp.status_code == 400
    assert me.avatar_url is None


def test_confirm_refuses_and_reclaims_an_oversized_upload(client, me, auth_headers):
    key = f"avatars/{me.id}/huge.webp"
    with patch(f"{S3}.head_object_size", return_value=3 * 1024 * 1024), \
            patch(f"{S3}.delete_object") as delete:
        resp = client.post(f"/users/{me.id}/avatar-confirm", json={"key": key}, headers=auth_headers)

    assert resp.status_code == 400
    assert me.avatar_url is None
    delete.assert_called_once_with(key)


def test_confirm_refuses_a_key_outside_the_callers_prefix(client, me, auth_headers):
    with patch(f"{S3}.head_object_size") as head:
        resp = client.post(
            f"/users/{me.id}/avatar-confirm", json={"key": "raw/p/secret.mp4"}, headers=auth_headers,
        )

    assert resp.status_code == 400
    head.assert_not_called()
    assert me.avatar_url is None


def test_confirm_replaces_the_avatar_and_deletes_the_old_one_after_commit(
    client, mock_db, me, auth_headers, presign_get,
):
    old = f"avatars/{me.id}/old.webp"
    new = f"avatars/{me.id}/new.webp"
    me.avatar_url = old
    events = []
    mock_db.commit.side_effect = lambda: events.append(("commit", me.avatar_url))

    with patch(f"{S3}.head_object_size", return_value=20_000), \
            patch(f"{S3}.delete_object", side_effect=lambda k: events.append(("delete", k))):
        resp = client.post(f"/users/{me.id}/avatar-confirm", json={"key": new}, headers=auth_headers)

    assert resp.status_code == 200
    assert me.avatar_url == new
    assert events == [("commit", new), ("delete", old)]
    assert resp.json()["avatar_url"] == f"https://s3.test/{new}"


def test_confirming_the_same_key_twice_does_not_delete_it(client, me, auth_headers, presign_get):
    key = f"avatars/{me.id}/same.webp"
    me.avatar_url = key

    with patch(f"{S3}.head_object_size", return_value=20_000), \
            patch(f"{S3}.delete_object") as delete:
        resp = client.post(f"/users/{me.id}/avatar-confirm", json={"key": key}, headers=auth_headers)

    assert resp.status_code == 200
    delete.assert_not_called()


# ── Remove ─────────────────────────────────────────────────────────────────────

def test_removing_the_avatar_clears_it_then_deletes_the_object(client, mock_db, me, auth_headers):
    old = f"avatars/{me.id}/old.webp"
    me.avatar_url = old
    events = []
    mock_db.commit.side_effect = lambda: events.append(("commit", me.avatar_url))

    with patch(f"{S3}.delete_object", side_effect=lambda k: events.append(("delete", k))):
        resp = client.delete(f"/users/{me.id}/avatar", headers=auth_headers)

    assert resp.status_code == 200
    assert resp.json()["avatar_url"] is None
    assert events == [("commit", None), ("delete", old)]


def test_removing_the_avatar_keeps_the_colour(client, me, auth_headers):
    """The colour is what shows once the picture is gone."""
    me.avatar_url = f"avatars/{me.id}/old.webp"
    me.avatar_color = "#112233"

    with patch(f"{S3}.delete_object"):
        resp = client.delete(f"/users/{me.id}/avatar", headers=auth_headers)

    assert resp.json()["avatar_color"] == "#112233"


def test_removing_someone_elses_avatar_is_refused(client, me, auth_headers):
    import uuid

    with patch(f"{S3}.delete_object") as delete:
        resp = client.delete(f"/users/{uuid.uuid4()}/avatar", headers=auth_headers)

    assert resp.status_code == 403
    delete.assert_not_called()
