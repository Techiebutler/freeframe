"""The Postgres driver is pinned to psycopg2 in the connection URL.

SQLAlchemy 2.1 changed the default driver for a bare ``postgresql://`` URL
from psycopg2 to psycopg (v3). We ship only psycopg2-binary, so the URL must
name psycopg2 explicitly; otherwise the engine fails to import its driver.
"""
from apps.api.database import pin_psycopg2_driver


def test_bare_postgresql_url_gets_psycopg2():
    assert (
        pin_psycopg2_driver("postgresql://user:pass@localhost:5432/db")
        == "postgresql+psycopg2://user:pass@localhost:5432/db"
    )


def test_postgres_scheme_gets_psycopg2():
    assert (
        pin_psycopg2_driver("postgres://user:pass@localhost:5432/db")
        == "postgresql+psycopg2://user:pass@localhost:5432/db"
    )


def test_explicit_driver_is_left_alone():
    assert (
        pin_psycopg2_driver("postgresql+psycopg2://u:p@h/db")
        == "postgresql+psycopg2://u:p@h/db"
    )
    assert (
        pin_psycopg2_driver("postgresql+psycopg://u:p@h/db")
        == "postgresql+psycopg://u:p@h/db"
    )


def test_non_postgres_url_is_left_alone():
    assert pin_psycopg2_driver("sqlite:///local.db") == "sqlite:///local.db"
