import os
import logging
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

log = logging.getLogger("freeframe.database")

# Import settings - handle both package and direct execution
try:
    from .config import settings
except ImportError:
    from config import settings


def pin_psycopg2_driver(url: str) -> str:
    """Make the psycopg2 driver explicit for a driver-less Postgres URL.

    SQLAlchemy 2.1 changed the default driver for a bare ``postgresql://``
    (or ``postgres://``) URL from psycopg2 to psycopg (v3). We ship only
    psycopg2-binary, so pin the driver in the URL. A URL that already names
    a driver (``postgresql+psycopg://``, ``postgresql+psycopg2://``) or a
    non-Postgres URL is returned unchanged.
    """
    for prefix in ("postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+psycopg2://" + url[len(prefix):]
    return url


engine = create_engine(pin_psycopg2_driver(settings.database_url))
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

class Base(DeclarativeBase):
    pass

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        _persist_admin_access_audit(db)
        db.close()


def _persist_admin_access_audit(db) -> None:
    """Give a read-only request's instance-admin audit row a chance to land.

    A GET never commits, so the row the permission gate added would be dropped
    at ``db.close()`` and the audit would only ever show writes. The helper
    commits nothing unless those rows are the whole of the pending work; see
    ``services.permissions.persist_admin_access_audit``. Imported here rather
    than at module import, because the permission service reaches back into the
    models, which reach back into this module.
    """
    try:
        from .services.permissions import persist_admin_access_audit
        persist_admin_access_audit(db)
    except Exception:
        log.warning("could not persist the admin access audit", exc_info=True)
