"""Opt-in, same-origin cookie transport for browser refresh tokens."""
from fastapi import HTTPException, Request, Response

from ..config import settings

HOST_COOKIE = "__Host-ff_refresh_token"
LEGACY_COOKIE = "ff_refresh_token"


def wants_cookie(request: Request) -> bool:
    return request.headers.get("X-FF-Client", "").lower() == "web"


def require_same_origin(request: Request) -> None:
    # Lax does not protect against requests from sibling origins on the same
    # site. In browsers without Fetch Metadata, verify Origin when available.
    site = request.headers.get("Sec-Fetch-Site")
    origin = request.headers.get("Origin")
    if site in {"cross-site", "same-site"} or (
        site != "same-origin" and origin is not None and origin != settings.frontend_origin
    ):
        raise HTTPException(status_code=403, detail="Cross-origin request rejected")


def _cookie_options() -> dict:
    return {"path": "/", "secure": True, "httponly": True, "samesite": "lax"}


def read_refresh_token(request: Request, body_token: str | None) -> str | None:
    require_same_origin(request)
    return request.cookies.get(HOST_COOKIE) or body_token


def refresh_token_for_body(request: Request, response: Response, token: str) -> dict[str, str]:
    if not wants_cookie(request):
        return {"refresh_token": token}
    require_same_origin(request)
    response.headers["Cache-Control"] = "no-store"
    response.set_cookie(
        key=HOST_COOKIE, value=token,
        max_age=settings.refresh_token_expire_days * 86400,
        **_cookie_options(),
    )
    response.delete_cookie(key=LEGACY_COOKIE, path="/")
    return {}


def clear_refresh_cookie(request: Request, response: Response) -> None:
    require_same_origin(request)
    response.delete_cookie(key=HOST_COOKIE, **_cookie_options())
    response.delete_cookie(key=LEGACY_COOKIE, path="/")
