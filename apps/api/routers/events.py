"""Live project events over Server-Sent Events.

Access is not decided once at connect. A stream can stay open for hours, so it
re-checks for as long as it is open (see event_service.event_stream) and ends
with a final `revoked` event once its subscriber may no longer see the project.
"""
import asyncio
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials

from ..config import settings
from ..database import SessionLocal
from ..middleware.auth import optional_bearer_scheme
from ..services.auth_service import decode_token
from ..services.event_service import event_stream
from ..services.permissions import EVENTS_ACCESS_REVOKED, project_events_denial

router = APIRouter(prefix="/events", tags=["events"])


def _access_claims(*tokens: Optional[str]) -> Optional[tuple[uuid.UUID, int, float]]:
    """(user id, token version, expiry) from the first valid access token given."""
    for raw in tokens:
        if not raw:
            continue
        payload = decode_token(raw)
        if not payload or payload.get("type") != "access":
            continue
        try:
            return uuid.UUID(str(payload["sub"])), int(payload.get("ver", 1)), float(payload["exp"])
        except (KeyError, TypeError, ValueError):
            continue
    return None


def _denial(project_id: uuid.UUID, user_id: uuid.UUID, token_version: int) -> Optional[str]:
    """One authorization check on its own short-lived session.

    A request-scoped session would stay checked out for the life of the
    stream, so each check opens and closes its own. Token expiry is not
    checked here: decode_token() refuses an expired token at connect, and
    event_stream compares `exp` before every write.
    """
    db = SessionLocal()
    try:
        return project_events_denial(db, project_id, user_id, token_version)
    finally:
        db.close()


@router.get("/{project_id}")
async def stream_events(
    project_id: uuid.UUID,
    # EventSource cannot send an Authorization header, so the access token may
    # come as a query parameter instead.
    token: Optional[str] = Query(None),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(optional_bearer_scheme),
):
    claims = _access_claims(credentials.credentials if credentials else None, token)
    if claims is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not authenticated")
    user_id, token_version, expires_at = claims

    async def authorize() -> Optional[str]:
        # The query is synchronous; keep it off the event loop.
        return await asyncio.to_thread(_denial, project_id, user_id, token_version)

    # Refuse here rather than open the stream and revoke it: a client resets its
    # reconnect backoff when a stream opens, so open-then-revoke would invite a
    # fast reconnect loop.
    checked_at = asyncio.get_running_loop().time()
    denial = await authorize()
    if denial is not None:
        detail = "Not allowed" if denial == EVENTS_ACCESS_REVOKED else "Not authenticated"
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)

    return StreamingResponse(
        event_stream(
            str(project_id),
            authorize,
            max_auth_age_seconds=settings.sse_auth_max_age_seconds,
            recheck_seconds=settings.sse_auth_recheck_seconds,
            expires_at=expires_at,
            checked_at=checked_at,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
