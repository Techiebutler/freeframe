"""Tests for share link password session management."""
import pytest
from unittest.mock import MagicMock, patch


class TestShareSession:
    """Tests for Redis-backed share sessions."""

    @patch("apps.api.services.redis_service.get_redis")
    def test_create_share_session(self, mock_get_redis):
        mock_redis = MagicMock()
        mock_get_redis.return_value = mock_redis

        from apps.api.services.redis_service import create_share_session

        create_share_session("abc123token", "session-id-456")

        mock_redis.setex.assert_called_once_with(
            "share_session:abc123token:session-id-456",
            3600,
            "1",
        )

    @patch("apps.api.services.redis_service.get_redis")
    def test_verify_share_session_valid(self, mock_get_redis):
        mock_redis = MagicMock()
        mock_redis.exists.return_value = 1
        mock_get_redis.return_value = mock_redis

        from apps.api.services.redis_service import verify_share_session

        result = verify_share_session("abc123token", "session-id-456")

        assert result is True
        mock_redis.exists.assert_called_once_with(
            "share_session:abc123token:session-id-456"
        )

    @patch("apps.api.services.redis_service.get_redis")
    def test_verify_share_session_invalid(self, mock_get_redis):
        mock_redis = MagicMock()
        mock_redis.exists.return_value = 0
        mock_get_redis.return_value = mock_redis

        from apps.api.services.redis_service import verify_share_session

        result = verify_share_session("abc123token", "bad-session")

        assert result is False


class TestValidateShareLinkWithSession:
    """Tests for share link validation with password session."""

    @patch("apps.api.services.permissions.verify_share_session")
    @patch("apps.api.services.permissions.validate_share_link")
    def test_no_password_passes_through(self, mock_validate, mock_verify_session):
        mock_link = MagicMock()
        mock_link.password_hash = None
        mock_validate.return_value = mock_link

        from apps.api.services.permissions import validate_share_link_with_session

        result = validate_share_link_with_session(MagicMock(), "token123")

        assert result == mock_link
        mock_verify_session.assert_not_called()

    @patch("apps.api.services.permissions.get_project_member")
    @patch("apps.api.services.permissions.verify_share_session")
    @patch("apps.api.services.permissions.validate_share_link")
    def test_password_link_creator_bypasses(self, mock_validate, mock_verify_session, mock_member):
        # The creator skips the password while they still edit the project.
        import uuid
        from apps.api.models.project import ProjectRole
        creator_id = uuid.uuid4()
        mock_link = MagicMock()
        mock_link.password_hash = "$2b$12$hashvalue"
        mock_link.created_by = creator_id
        mock_validate.return_value = mock_link
        mock_member.return_value = MagicMock(role=ProjectRole.editor)

        mock_user = MagicMock()
        mock_user.id = creator_id

        from apps.api.services.permissions import validate_share_link_with_session

        result = validate_share_link_with_session(
            MagicMock(), "token123", current_user=mock_user
        )

        assert result == mock_link
        mock_verify_session.assert_not_called()

    @pytest.mark.parametrize("role", [None, "reviewer", "viewer"])
    @patch("apps.api.services.permissions.get_project_member")
    @patch("apps.api.services.permissions.verify_share_session")
    @patch("apps.api.services.permissions.validate_share_link")
    def test_password_link_creator_no_longer_editing_needs_a_session(
        self, mock_validate, mock_verify_session, mock_member, role,
    ):
        # Removed from the project (no membership) or demoted below editor:
        # the creator needs a session like any guest.
        import uuid
        from apps.api.models.project import ProjectRole
        creator_id = uuid.uuid4()
        mock_link = MagicMock()
        mock_link.password_hash = "$2b$12$hashvalue"
        mock_link.created_by = creator_id
        mock_validate.return_value = mock_link
        mock_member.return_value = None if role is None else MagicMock(role=ProjectRole(role))

        mock_user = MagicMock()
        mock_user.id = creator_id

        from apps.api.services.permissions import validate_share_link_with_session

        with pytest.raises(Exception) as exc_info:
            validate_share_link_with_session(MagicMock(), "token123", current_user=mock_user)
        assert exc_info.value.status_code == 403

    @patch("apps.api.services.permissions.verify_share_session")
    @patch("apps.api.services.permissions.validate_share_link")
    def test_password_link_valid_session(self, mock_validate, mock_verify_session):
        mock_link = MagicMock()
        mock_link.password_hash = "$2b$12$hashvalue"
        mock_link.created_by = None
        mock_validate.return_value = mock_link
        mock_verify_session.return_value = True

        from apps.api.services.permissions import validate_share_link_with_session

        result = validate_share_link_with_session(
            MagicMock(), "token123", share_session="sess-abc"
        )

        assert result == mock_link
        mock_verify_session.assert_called_once_with("token123", "sess-abc")

    @patch("apps.api.services.permissions.verify_share_session")
    @patch("apps.api.services.permissions.validate_share_link")
    def test_password_link_no_session_raises(self, mock_validate, mock_verify_session):
        mock_link = MagicMock()
        mock_link.password_hash = "$2b$12$hashvalue"
        mock_link.created_by = None
        mock_validate.return_value = mock_link

        from apps.api.services.permissions import validate_share_link_with_session

        with pytest.raises(Exception) as exc_info:
            validate_share_link_with_session(MagicMock(), "token123")
        assert exc_info.value.status_code == 403

    @patch("apps.api.services.permissions.verify_share_session")
    @patch("apps.api.services.permissions.validate_share_link")
    def test_password_link_invalid_session_raises(self, mock_validate, mock_verify_session):
        mock_link = MagicMock()
        mock_link.password_hash = "$2b$12$hashvalue"
        mock_link.created_by = None
        mock_validate.return_value = mock_link
        mock_verify_session.return_value = False

        from apps.api.services.permissions import validate_share_link_with_session

        with pytest.raises(Exception) as exc_info:
            validate_share_link_with_session(
                MagicMock(), "token123", share_session="bad-session"
            )
        assert exc_info.value.status_code == 403
