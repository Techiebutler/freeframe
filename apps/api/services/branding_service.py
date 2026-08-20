"""Instance branding lookups for code that runs outside a request."""
import time
from typing import Optional

# Used until an admin sets a name, and whenever the row or the database can't
# be read. A missing brand name must never be the reason an email fails.
DEFAULT_ORG_NAME = "FreeFrame"

_CACHE_TTL_SECONDS = 60
_cached: Optional[tuple[float, str]] = None


def resolve_org_name() -> str:
    """The instance's display name, for email subjects, bodies and From lines.

    Emails render in the Celery worker, which has no request-scoped session, so
    the name is read here rather than threaded through all eight send tasks.
    The six that never carried it are exactly why a white-labelled instance
    still sent mail branded FreeFrame. Cached briefly since branding changes
    rarely and every email would otherwise cost a query.
    """
    global _cached
    now = time.monotonic()
    if _cached and now - _cached[0] < _CACHE_TTL_SECONDS:
        return _cached[1]

    name = DEFAULT_ORG_NAME
    try:
        from ..database import SessionLocal
        from ..models.instance_branding import InstanceBranding

        db = SessionLocal()
        try:
            row = db.query(InstanceBranding).first()
            if row and row.org_name:
                name = row.org_name
        finally:
            db.close()
    except Exception:
        # Worker started before the database, or migrations not yet applied.
        pass

    _cached = (now, name)
    return name


def reset_org_name_cache() -> None:
    """Drop the cached name so a just-saved change is visible immediately."""
    global _cached
    _cached = None
