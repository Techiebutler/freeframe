"""A `secure` share link must require a logged-in caller on every endpoint.

Gating visibility only in GET /share/{token} and POST /share/{token}/verify left
the endpoints that actually serve content reachable with the token alone, so an
anonymous caller who knew the token could stream, download, list versions and
read or post comments on a link whose whole point was to require a login. Those
endpoints all resolve the link through validate_share_link_with_session, so the
check belongs there.
"""
import uuid
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException


def _link(visibility="secure", password_hash=None):
    link = MagicMock()
    link.visibility = visibility
    link.password_hash = password_hash
    link.created_by = uuid.uuid4()
    return link


class TestVisibilityIsEnforcedForEveryCaller:
    @patch("apps.api.services.permissions.validate_share_link")
    def test_anonymous_caller_is_refused_a_secure_link(self, mock_validate):
        mock_validate.return_value = _link()

        from apps.api.services.permissions import validate_share_link_with_session

        with pytest.raises(HTTPException) as exc:
            validate_share_link_with_session(MagicMock(), "tok", current_user=None)

        assert exc.value.status_code == 403

    @patch("apps.api.services.permissions.validate_share_link")
    def test_authenticated_caller_is_allowed_a_secure_link(self, mock_validate):
        link = _link()
        mock_validate.return_value = link

        from apps.api.services.permissions import validate_share_link_with_session

        assert validate_share_link_with_session(
            MagicMock(), "tok", current_user=MagicMock()
        ) is link

    @patch("apps.api.services.permissions.validate_share_link")
    def test_a_public_link_still_needs_no_login(self, mock_validate):
        link = _link(visibility="public")
        mock_validate.return_value = link

        from apps.api.services.permissions import validate_share_link_with_session

        assert validate_share_link_with_session(
            MagicMock(), "tok", current_user=None
        ) is link

    @patch("apps.api.services.permissions.verify_share_session", return_value=True)
    @patch("apps.api.services.permissions.validate_share_link")
    def test_a_valid_password_session_does_not_satisfy_secure(
        self, mock_validate, _mock_verify
    ):
        """Holding the password is not the same as being logged in — a secure
        link demands both."""
        mock_validate.return_value = _link(password_hash="$2b$12$hash")

        from apps.api.services.permissions import validate_share_link_with_session

        with pytest.raises(HTTPException) as exc:
            validate_share_link_with_session(
                MagicMock(), "tok", share_session="valid-session", current_user=None
            )

        assert exc.value.status_code == 403


class TestContentEndpointsRefuseAnonymousSecureLinks:
    @patch("apps.api.services.permissions.validate_share_link")
    def test_guest_comment_listing_is_refused(self, mock_validate, client):
        mock_validate.return_value = _link()

        resp = client.get("/share/sometoken/comments")

        assert resp.status_code == 403

    @patch("apps.api.services.permissions.validate_share_link")
    def test_guest_comment_listing_is_allowed_for_a_public_link(
        self, mock_validate, client
    ):
        """The same request on a public link is untouched by the new gate —
        it gets past validation rather than 403ing."""
        link = _link(visibility="public")
        link.asset_id = None
        mock_validate.return_value = link

        resp = client.get("/share/sometoken/comments")

        assert resp.status_code == 200
