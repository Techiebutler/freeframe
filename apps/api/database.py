import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

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
        db.close()
