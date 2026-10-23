"""Tests for rate limiting functionality."""
import pytest
from unittest.mock import MagicMock, patch


class TestCheckRateLimit:
    """Tests for the Redis-based rate limit checker."""

    @patch("apps.api.services.redis_service.get_redis")
    def test_allows_request_under_limit(self, mock_get_redis):
        mock_redis = MagicMock()
        mock_redis.get.return_value = None
        mock_pipe = MagicMock()
        mock_redis.pipeline.return_value = mock_pipe
        mock_get_redis.return_value = mock_redis

        from apps.api.services.redis_service import check_rate_limit

        allowed, retry_after = check_rate_limit("127.0.0.1", "test_action", 5, 60)

        assert allowed is True
        assert retry_after == 0
        mock_pipe.incr.assert_called_once()
        mock_pipe.expire.assert_called_once()
        mock_pipe.execute.assert_called_once()

    @patch("apps.api.services.redis_service.get_redis")
    def test_blocks_request_at_limit(self, mock_get_redis):
        mock_redis = MagicMock()
        mock_redis.get.return_value = "5"
        mock_redis.ttl.return_value = 42
        mock_get_redis.return_value = mock_redis

        from apps.api.services.redis_service import check_rate_limit

        allowed, retry_after = check_rate_limit("127.0.0.1", "test_action", 5, 60)

        assert allowed is False
        assert retry_after == 42

    @patch("apps.api.services.redis_service.get_redis")
    def test_allows_request_below_limit(self, mock_get_redis):
        mock_redis = MagicMock()
        mock_redis.get.return_value = "3"
        mock_pipe = MagicMock()
        mock_redis.pipeline.return_value = mock_pipe
        mock_get_redis.return_value = mock_redis

        from apps.api.services.redis_service import check_rate_limit

        allowed, retry_after = check_rate_limit("127.0.0.1", "test_action", 5, 60)

        assert allowed is True
        assert retry_after == 0

    @patch("apps.api.services.redis_service.get_redis")
    def test_retry_after_minimum_is_one(self, mock_get_redis):
        mock_redis = MagicMock()
        mock_redis.get.return_value = "10"
        mock_redis.ttl.return_value = -1
        mock_get_redis.return_value = mock_redis

        from apps.api.services.redis_service import check_rate_limit

        allowed, retry_after = check_rate_limit("127.0.0.1", "test_action", 10, 60)

        assert allowed is False
        assert retry_after == 1


class TestRateLimitDependency:
    """Tests for the FastAPI rate_limit dependency."""

    @patch("apps.api.middleware.rate_limit.check_rate_limit")
    def test_allows_when_under_limit(self, mock_check):
        mock_check.return_value = (True, 0)
        mock_request = MagicMock()
        mock_request.headers.get.return_value = "10.0.0.1"

        from apps.api.middleware.rate_limit import rate_limit

        dep = rate_limit("test", 5, 60)
        dep(mock_request)  # Should not raise

        mock_check.assert_called_once_with("10.0.0.1", "test", 5, 60)

    @patch("apps.api.middleware.rate_limit.check_rate_limit")
    def test_raises_429_when_over_limit(self, mock_check):
        mock_check.return_value = (False, 30)
        mock_request = MagicMock()
        mock_request.headers.get.return_value = "10.0.0.1"

        from apps.api.middleware.rate_limit import rate_limit

        dep = rate_limit("test", 5, 60)
        with pytest.raises(Exception) as exc_info:
            dep(mock_request)
        assert exc_info.value.status_code == 429

    @patch("apps.api.middleware.rate_limit.check_rate_limit")
    def test_falls_back_to_client_host(self, mock_check):
        mock_check.return_value = (True, 0)
        mock_request = MagicMock()
        mock_request.headers.get.return_value = None
        mock_request.client.host = "192.168.1.1"

        from apps.api.middleware.rate_limit import rate_limit

        dep = rate_limit("test", 5, 60)
        dep(mock_request)

        mock_check.assert_called_once_with("192.168.1.1", "test", 5, 60)


class TestGlobalRateLimitMiddleware:
    """Tests for the global rate limit middleware."""

    def test_exempt_paths_skipped(self):
        from apps.api.middleware.global_rate_limit import GlobalRateLimitMiddleware, EXEMPT_PATHS

        assert "/health" in EXEMPT_PATHS
        assert "/docs" in EXEMPT_PATHS
        assert "/redoc" in EXEMPT_PATHS
        assert "/openapi.json" in EXEMPT_PATHS

    @patch("apps.api.middleware.global_rate_limit.get_redis")
    def test_get_identity_extracts_user_from_jwt(self, mock_get_redis):
        from apps.api.middleware.global_rate_limit import GlobalRateLimitMiddleware
        from apps.api.config import settings

        middleware = GlobalRateLimitMiddleware(app=MagicMock())

        import jwt
        token = jwt.encode(
            {"sub": "user-123", "type": "access"},
            settings.jwt_secret,
            algorithm=settings.jwt_algorithm,
        )
        mock_request = MagicMock()
        mock_request.headers.get.return_value = f"Bearer {token}"

        identity = middleware._get_identity(mock_request)
        assert identity == "user:user-123"

    def test_get_identity_falls_back_to_ip(self):
        from apps.api.middleware.global_rate_limit import GlobalRateLimitMiddleware

        middleware = GlobalRateLimitMiddleware(app=MagicMock())
        mock_request = MagicMock()
        mock_request.headers.get.side_effect = lambda key, default="": {
            "authorization": "",
            "x-real-ip": "203.0.113.1",
        }.get(key, default)

        identity = middleware._get_identity(mock_request)
        assert identity == "ip:203.0.113.1"

    @patch("apps.api.middleware.global_rate_limit.get_redis")
    def test_check_allows_under_limit(self, mock_get_redis):
        from apps.api.middleware.global_rate_limit import GlobalRateLimitMiddleware

        mock_redis = MagicMock()
        mock_redis.get.return_value = None
        mock_pipe = MagicMock()
        mock_redis.pipeline.return_value = mock_pipe
        mock_get_redis.return_value = mock_redis

        middleware = GlobalRateLimitMiddleware(app=MagicMock())
        allowed, retry_after = middleware._check("user:123", "global_r", 600)

        assert allowed is True
        assert retry_after == 0

    @patch("apps.api.middleware.global_rate_limit.get_redis")
    def test_check_blocks_over_limit(self, mock_get_redis):
        from apps.api.middleware.global_rate_limit import GlobalRateLimitMiddleware

        mock_redis = MagicMock()
        mock_redis.get.return_value = "600"
        mock_redis.ttl.return_value = 25
        mock_get_redis.return_value = mock_redis

        middleware = GlobalRateLimitMiddleware(app=MagicMock())
        allowed, retry_after = middleware._check("user:123", "global_r", 600)

        assert allowed is False
        assert retry_after == 25


class TestShortCircuitResponsesCarryCors:
    """A response a middleware returns on its own still reaches the browser readable (#525).

    Without Access-Control-Allow-Origin the browser hides the status, so a 429
    from the limiter (or the setup guard's 503) surfaced as a network error and
    the client could not read Retry-After to back off. `http://localhost:3000`
    is always in `settings.cors_origins`, and the any-origin regex echoes it too.
    """

    ORIGIN = "http://localhost:3000"

    @pytest.fixture
    def limited(self, monkeypatch):
        from apps.api.middleware.global_rate_limit import GlobalRateLimitMiddleware

        monkeypatch.setattr(GlobalRateLimitMiddleware, "_check", lambda self, *a: (False, 7))

    def test_rate_limit_429_has_cors_headers(self, client, limited):
        resp = client.get("/projects", headers={"Origin": self.ORIGIN})

        assert resp.status_code == 429
        assert resp.headers.get("retry-after") == "7"
        assert resp.headers.get("access-control-allow-origin") == self.ORIGIN
        exposed = resp.headers.get("access-control-expose-headers", "").lower()
        assert "retry-after" in exposed

    def test_preflight_is_answered_while_rate_limited(self, client, limited):
        # An authenticated GET is preflighted. If the preflight itself got the
        # bare 429, the browser would never send the request that carries one.
        resp = client.options(
            "/projects",
            headers={
                "Origin": self.ORIGIN,
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization",
            },
        )

        assert resp.status_code == 200
        assert resp.headers.get("access-control-allow-origin") == self.ORIGIN

    def test_setup_guard_503_has_cors_headers(self, client, monkeypatch):
        monkeypatch.setattr("apps.api.middleware.setup_guard._setup_complete", False)
        session = MagicMock()
        session.query.return_value.filter.return_value.first.return_value = None
        monkeypatch.setattr("apps.api.database.SessionLocal", lambda: session)

        resp = client.get("/projects", headers={"Origin": self.ORIGIN})

        assert resp.status_code == 503
        assert resp.json()["needs_setup"] is True
        assert resp.headers.get("access-control-allow-origin") == self.ORIGIN

    def test_normal_response_still_has_cors_headers(self, client):
        resp = client.get("/health", headers={"Origin": self.ORIGIN})

        assert resp.status_code == 200
        assert resp.headers.get("access-control-allow-origin") == self.ORIGIN
