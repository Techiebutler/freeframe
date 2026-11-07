from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import uuid
from typing import Optional
from sqlalchemy.orm import Session
from ..database import get_db
import secrets as _secrets

from ..services.whop_auth import require_customer_entitlement
from ..services.auth_service import decode_token, get_user_by_id, get_user_by_email
from ..models.user import User, UserStatus
from ..config import settings

class ProxySafeBearer(HTTPBearer):
    """Keep JWT authentication working through Whop's Authorization-stripping proxy."""
    async def __call__(self, request: Request) -> Optional[HTTPAuthorizationCredentials]:
        credentials = await super().__call__(request)
        if request.headers.get('authorization'):
            return credentials
        token = request.headers.get('x-freeframe-token')
        return HTTPAuthorizationCredentials(scheme='Bearer', credentials=token) if token else None


bearer_scheme = ProxySafeBearer(auto_error=False, scheme_name='HTTPBearer')
optional_bearer_scheme = ProxySafeBearer(auto_error=False, scheme_name='HTTPBearer')

def _service_key_user(request: Request, db: Session) -> Optional[User]:
    """Resolve a read-only service principal from the X-API-Key header.

    Returns None when the mechanism is unconfigured or the header is absent, so
    the caller falls through to normal bearer auth.
    """
    configured = settings.service_api_key
    if not configured or not settings.service_api_key_email:
        return None
    presented = request.headers.get("x-api-key")
    if not presented:
        return None
    # Constant time: a plain == leaks the shared secret one byte at a time.
    if not _secrets.compare_digest(presented, configured):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API key")
    if request.method != "GET":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="API key is read-only",
        )
    user = get_user_by_email(db, settings.service_api_key_email)
    if not user or user.status == UserStatus.deactivated:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Service account unavailable")
    require_customer_entitlement(user)
    return user


def get_identity_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    service_user = _service_key_user(request, db)
    if service_user:
        return service_user
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    token = credentials.credentials
    payload = decode_token(token)
    if not payload or payload.get("type") != "access":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    user = get_user_by_id(db, uuid.UUID(payload["sub"]))
    if not user or user.status == UserStatus.deactivated:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or deactivated")
    require_customer_entitlement(user, allow_expired=True)
    return user


def _promote_listed_superadmin(user: User, db: Session) -> None:
    """A signed-in staff person whose email is in SUPERADMIN_EMAILS becomes a superadmin (settings.superadmin_emails)."""
    listed = {e.strip().lower() for e in (settings.superadmin_emails or "").split(",") if e.strip()}
    if not listed or user.is_superadmin or getattr(user, "is_staff", True) is False:
        return
    if (user.email or "").strip().lower() in listed:
        user.is_superadmin = True
        db.commit()


def get_current_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    user = get_identity_user(request, credentials, db)
    _promote_listed_superadmin(user, db)
    from ..services.campaign_access import preview_expired, expired_error
    if preview_expired(user):
        raise expired_error()
    return user

def get_optional_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(optional_bearer_scheme),
    db: Session = Depends(get_db),
) -> Optional[User]:
    """Returns the authenticated user if a valid token is provided, None otherwise."""
    try:
        service_user = _service_key_user(request, db)
    except HTTPException:
        # On the optional path a bad key is simply "not authenticated" - these
        # endpoints are reachable by anonymous guests via share links.
        return None
    if service_user:
        return service_user
    if not credentials:
        return None
    try:
        payload = decode_token(credentials.credentials)
        if not payload or payload.get("type") != "access":
            return None
        user = get_user_by_id(db, uuid.UUID(payload["sub"]))
        if not user or user.status == UserStatus.deactivated:
            return None
        require_customer_entitlement(user)
        return user
    except Exception:
        return None


def get_agent(request: Request, db: Session = Depends(get_db)) -> "AgentContext":
    """The paired agent behind `Authorization: Bearer ara_...`; it only ever acts inside its one project.
    Scope and the per-key limit are checked here, once for every agent route."""
    from ..services.agents import presented_key, resolve_key
    token = presented_key(request.headers.get("authorization"))
    if token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_agent_key")
    return _agent_gate(request, resolve_key(db, token))


def _agent_gate(request: Request, agent: "AgentContext") -> "AgentContext":
    from ..services.agents import require_scope
    from ..services.redis_service import check_rate_limit
    write = request.method not in ("GET", "HEAD", "OPTIONS")
    require_scope(agent, write)
    # ponytail: fixed 10-min windows per key; 120 reads / 30 writes (spec G). Upload parts keep their own /r/ limit.
    allowed, retry_after = check_rate_limit(str(agent.key.id), "agent_write" if write else "agent_read", 30 if write else 120, 600)
    if not allowed:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="rate_limited",
                            headers={"Retry-After": str(retry_after)})
    return agent


def get_optional_agent(request: Request, db: Session = Depends(get_db)) -> "Optional[AgentContext]":
    """None for anyone without an ara_ key (a guest editor); a bad ara_ key still fails loudly."""
    from ..services.agents import presented_key, resolve_key
    token = presented_key(request.headers.get("authorization"))
    if not token:
        return None
    from ..services.agents import require_scope
    agent = resolve_key(db, token)
    require_scope(agent, request.method not in ("GET", "HEAD", "OPTIONS"))  # hand-in routes: a read key may not upload
    return agent
