"""
Setup guard middleware.

Blocks all API requests (except /setup/*, /health, /docs, /redoc, /openapi.json)
until initial setup is complete (a superadmin exists).

Uses a cached flag so the database check only runs once — after setup completes,
all subsequent requests pass through without any DB query.
"""

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

# Once setup is confirmed, skip the check for all future requests
_setup_complete = False

EXEMPT_PREFIXES = (
    "/setup",
    "/health",
    "/docs",
    "/redoc",
    "/openapi.json",
    "/share/",     # Public share links should work regardless
)


class SetupGuardMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        global _setup_complete

        if _setup_complete:
            return await call_next(request)

        path = request.url.path

        # Always allow exempt paths
        if any(path.startswith(prefix) for prefix in EXEMPT_PREFIXES):
            return await call_next(request)

        # Check if setup is done (query DB once, then cache)
        try:
            from ..database import SessionLocal
            from ..models.user import User

            db = SessionLocal()
            try:
                has_admin = db.query(User).filter(
                    User.is_superadmin == True,
                    User.deleted_at.is_(None),
                ).first() is not None
            finally:
                db.close()

            if has_admin:
                _setup_complete = True
                return await call_next(request)
        except Exception:
            # If DB check fails, allow the request through (fail open)
            return await call_next(request)

        return JSONResponse(
            status_code=503,
            content={
                "detail": "FreeFrame is not set up yet. Please complete initial setup.",
                "needs_setup": True,
            },
        )
