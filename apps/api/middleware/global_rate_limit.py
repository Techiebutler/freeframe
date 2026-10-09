"""
Global per-user / per-IP rate limiting middleware.

Applies to all API requests. Uses Redis sliding window counters.
- Authenticated users: keyed by user ID (from JWT)
- Unauthenticated requests: keyed by IP

Separate limits for read (GET/HEAD/OPTIONS) vs write (POST/PUT/PATCH/DELETE).
"""

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
import jwt

from ..config import settings
from ..services.redis_service import get_redis

# Limits per window — tuned for media-review workflows where a single folder
# page can trigger 10+ paginated asset fetches plus SWR calls for project,
# members, folders, etc., and bulk uploads generate many write requests.
READ_LIMIT = 600       # GET requests per window
WRITE_LIMIT = 300      # Mutating requests per window
WINDOW_SECONDS = 60    # 1-minute window

# Paths exempt from global rate limiting (they have their own)
EXEMPT_PATHS = {
    "/health",
    "/docs",
    "/redoc",
    "/openapi.json",
}


class GlobalRateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # Skip exempt paths — uploads are auth-gated and have their own flow control
        if path in EXEMPT_PATHS or path.startswith("/stream/") or path.startswith("/upload/"):
            return await call_next(request)

        # Determine identity: user_id from JWT or IP
        identity = self._get_identity(request)

        # Determine limit based on method
        is_write = request.method in ("POST", "PUT", "PATCH", "DELETE")
        action = "global_w" if is_write else "global_r"
        limit = WRITE_LIMIT if is_write else READ_LIMIT

        # Check rate limit
        allowed, retry_after = self._check(identity, action, limit)
        if not allowed:
            return JSONResponse(
                status_code=429,
                content={"detail": f"Too many requests. Try again in {retry_after}s."},
                headers={"Retry-After": str(retry_after)},
            )

        return await call_next(request)

    def _get_identity(self, request: Request) -> str:
        """Extract user ID from JWT or fall back to IP."""
        auth_header = request.headers.get("authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
            try:
                payload = jwt.decode(
                    token, settings.jwt_secret,
                    algorithms=[settings.jwt_algorithm],
                    options={"verify_exp": False},
                )
                user_id = payload.get("sub")
                if user_id:
                    return f"user:{user_id}"
            except jwt.InvalidTokenError:
                pass

        # Fall back to IP
        ip = request.headers.get("x-real-ip") or (
            request.client.host if request.client else "unknown"
        )
        return f"ip:{ip}"

    def _check(self, identity: str, action: str, max_requests: int) -> tuple[bool, int]:
        try:
            r = get_redis()
            key = f"grl:{action}:{identity}"
            current = r.get(key)

            if current is not None and int(current) >= max_requests:
                ttl = r.ttl(key)
                return False, max(ttl, 1)

            pipe = r.pipeline()
            pipe.incr(key)
            pipe.expire(key, WINDOW_SECONDS, nx=True)
            pipe.execute()
            return True, 0
        except Exception:
            # Fail open — allow the request if Redis is unavailable
            return True, 0
