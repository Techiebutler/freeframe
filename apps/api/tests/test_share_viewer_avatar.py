"""A signed-in viewer's picture and circle colour reach the share page.

The share response carried the viewer's name and email but not the avatar, so
the folder share header drew initials on a fixed green circle even for someone
with a picture. The key is presigned like every other user response.
"""
import uuid
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from apps.api.models.share import SharePermission
from apps.api.routers.share import _build_share_validate_response


def _folder_link():
    return SimpleNamespace(
        id=uuid.uuid4(),
        asset_id=None,
        folder_id=uuid.uuid4(),
        project_id=None,
        title="Dailies",
        description=None,
        permission=SharePermission.comment,
        visibility="public",
        allow_download=False,
        show_versions=True,
        show_watermark=False,
        appearance=None,
        created_by=uuid.uuid4(),
    )


@pytest.fixture
def presign_get():
    with patch(
        "apps.api.services.s3_service.generate_presigned_get_url",
        side_effect=lambda key, *a, **kw: f"https://s3.test/{key}",
    ) as m:
        yield m


def test_a_signed_in_viewer_gets_their_picture_and_colour(mock_db, test_user, presign_get):
    mock_db.first.return_value = None  # no folder name or creator to resolve
    test_user.avatar_url = f"avatars/{test_user.id}/pic.webp"
    test_user.avatar_color = "#a1b2c3"

    resp = _build_share_validate_response(mock_db, _folder_link(), test_user)

    assert resp.viewer_avatar_url == f"https://s3.test/avatars/{test_user.id}/pic.webp"
    assert resp.viewer_avatar_color == "#a1b2c3"


def test_a_viewer_without_a_picture_gets_none(mock_db, test_user, presign_get):
    mock_db.first.return_value = None
    test_user.avatar_url = None
    test_user.avatar_color = None

    resp = _build_share_validate_response(mock_db, _folder_link(), test_user)

    assert resp.viewer_avatar_url is None
    assert resp.viewer_avatar_color is None
    presign_get.assert_not_called()


def test_an_anonymous_viewer_gets_no_avatar(mock_db, presign_get):
    mock_db.first.return_value = None

    resp = _build_share_validate_response(mock_db, _folder_link(), None)

    assert resp.viewer_name is None
    assert resp.viewer_avatar_url is None
    assert resp.viewer_avatar_color is None


@pytest.mark.parametrize("stored", [
    "avatars/00000000-0000-0000-0000-000000000000/pic.webp",  # another user's
    "processed/p/a/v/master.m3u8",                             # not an avatar
    "https://evil.test/x.png",                                 # a full URL
])
def test_a_viewer_avatar_that_is_not_their_own_upload_is_not_signed(mock_db, test_user, presign_get, stored):
    """Same guard as every user response (GHSA-q5pw-99q5-vp8x): the column is
    only trusted when it names this user's own uploaded avatar."""
    mock_db.first.return_value = None
    test_user.avatar_url = stored

    resp = _build_share_validate_response(mock_db, _folder_link(), test_user)

    assert resp.viewer_avatar_url is None
    presign_get.assert_not_called()
