"""A display name set through the profile endpoint is held to the same rule as one
set on the accept-invite screen.

`DisplayName` was introduced for accept-invite because `min_length=1` counts
characters, so "   " satisfies it and then strips to "", which `User.name`
accepts (`String(255), nullable=False`) and which renders as a blank author on
every comment the person has written, in the members list and in mention
autocomplete.

`PATCH /users/{user_id}` writes the same column and had no such rule, so the
hole was still open one request later, and reachable by anyone on their own
account with no elevated role.
"""
import uuid

import pytest


def _target(mock_db, test_user):
    """Make the endpoint resolve `user_id` to the caller's own record."""
    mock_db.first.return_value = test_user
    return test_user.id


def test_a_blank_name_is_refused(client, mock_db, test_user, auth_headers):
    """Whitespace only is a 422, not a 200 that stores an empty string."""
    user_id = _target(mock_db, test_user)
    before = test_user.name

    resp = client.patch(f"/users/{user_id}", json={"name": "   "}, headers=auth_headers)

    assert resp.status_code == 422
    assert test_user.name == before, "the name was written despite the refusal"


def test_a_name_is_stored_trimmed(client, mock_db, test_user, auth_headers):
    """Surrounding whitespace is not part of a display name."""
    user_id = _target(mock_db, test_user)

    resp = client.patch(
        f"/users/{user_id}", json={"name": "  Patrick Rosen  "}, headers=auth_headers
    )

    assert resp.status_code == 200
    assert test_user.name == "Patrick Rosen"


def test_omitting_the_name_leaves_it_alone(client, mock_db, test_user, auth_headers):
    """This is a PATCH: a body that does not mention the name must not touch it."""
    user_id = _target(mock_db, test_user)
    before = test_user.name

    resp = client.patch(
        f"/users/{user_id}", json={"avatar_url": "https://example.test/a.png"},
        headers=auth_headers,
    )

    assert resp.status_code == 200
    assert test_user.name == before


def test_a_name_longer_than_the_column_is_refused(client, mock_db, test_user, auth_headers):
    """`User.name` is String(255), so the bound belongs at the edge rather than
    surfacing as a database error."""
    user_id = _target(mock_db, test_user)

    resp = client.patch(
        f"/users/{user_id}", json={"name": "x" * 256}, headers=auth_headers
    )

    assert resp.status_code == 422
