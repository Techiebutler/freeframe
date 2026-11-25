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


def require_same_origin_for_web(request: Request) -> None:
    if wants_cookie(request):
        require_same_origin(request)


def _cookie_options() -> dict:
    return {"path": "/", "secure": True, "httponly": True, "samesite": "lax"}


def read_refresh_token(request: Request) -> str | None:
    require_same_origin(request)
    # request.cookies strips more than spaces from names, so a padded name that
    # a browser does not treat as __Host- would be read as this cookie.
    for header in request.headers.getlist("cookie"):
        for part in header.split(";"):
            name, _, value = part.strip(" \t").partition("=")
            if name == HOST_COOKIE:
                return value
    return None


def refresh_token_for_body(request: Request, response: Response, token: str) -> dict[str, str]:
    if not wants_cookie(request):
        return {"refresh_token": token}
    response.headers["Cache-Control"] = "no-store"
    response.set_cookie(
        key=HOST_COOKIE, value=token,
        max_age=settings.refresh_token_expire_days * 86400,
        **_cookie_options(),
    )
    response.delete_cookie(key=LEGACY_COOKIE, path="/")
    return {}


def expire_host_refresh_cookie(response: Response) -> None:
    response.delete_cookie(key=HOST_COOKIE, **_cookie_options())


def clear_refresh_cookie(request: Request, response: Response) -> None:
    require_same_origin(request)
    expire_host_refresh_cookie(response)
    response.delete_cookie(key=LEGACY_COOKIE, path="/")
