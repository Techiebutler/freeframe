"""Helpers for building user-supplied search queries."""


def escape_like(s: str) -> str:
    """Escape special LIKE pattern characters so user-supplied search text is
    matched literally (not as wildcards).

    Not SQL injection — SQLAlchemy parameterizes — but `%`/`_` would otherwise
    act as wildcards and could be used to enumerate or DoS the search. Every
    `ilike()` built from caller-supplied text must go through this; keeping it
    in one place is what stops a new call site from quietly shipping unescaped.
    """
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
