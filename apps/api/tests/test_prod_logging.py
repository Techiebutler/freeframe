"""Production logging wiring (#262).

The prod compose used to run every Celery service at --loglevel=warning, which
dropped every INFO outcome line the maintenance tasks write, and gunicorn ran
without an access log. Turning the access log on writes request URLs, and some
of ours carry credentials in the query string (?token= on /hls and /events,
?share_session= on share routes), so the API strips query strings from
uvicorn's access records.
"""
import logging
import shlex
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
PROD_COMPOSE = REPO_ROOT / "docker-compose.prod.yml"
API_DOCKERFILE = REPO_ROOT / "apps/api/Dockerfile.prod"
CELERY_SERVICES = ("worker", "email_worker", "maintenance_worker", "beat")


def _prod_services():
    return yaml.safe_load(PROD_COMPOSE.read_text())["services"]


def _tokens(command: str) -> list[str]:
    tokens = shlex.split(command)
    # The prod compose wraps the real command in `sh -c "..."`.
    if tokens[:2] == ["sh", "-c"]:
        tokens = shlex.split(tokens[2])
    return tokens


def _loglevel(command: str) -> str:
    [level] = [t.split("=", 1)[1] for t in _tokens(command) if t.startswith("--loglevel=")]
    return level


def test_prod_celery_services_default_to_info_and_are_overridable():
    services = _prod_services()
    for name in CELERY_SERVICES:
        # `$$` is compose's escape for a literal `$`, so sh expands it from .env.prod.
        assert _loglevel(services[name]["command"]) == "$${CELERY_LOGLEVEL:-info}", name


def test_prod_compose_gunicorn_writes_an_access_log():
    tokens = _tokens(_prod_services()["api"]["command"])
    gunicorn = tokens[tokens.index("gunicorn"):]
    i = gunicorn.index("--access-logfile")
    assert gunicorn[i + 1] == "-"


def test_api_image_gunicorn_writes_an_access_log():
    text = API_DOCKERFILE.read_text()
    cmd = text[text.index('CMD ["gunicorn"'):]
    assert '"--access-logfile", "-"' in cmd


def test_api_image_runtime_user_gets_a_home_directory():
    """gunicorn's arbiter puts its control socket under `$HOME/.gunicorn`, and
    `adduser --no-create-home` leaves a passwd entry whose home does not exist,
    so the arbiter logged `Control server error: [Errno 13] Permission denied`.
    """
    lines = API_DOCKERFILE.read_text().splitlines()
    [user] = [line.split()[1] for line in lines if line.startswith("USER ")]
    [adduser] = [line for line in lines if "adduser" in line and user in line]
    assert "--no-create-home" not in adduser, adduser


def _emit_like_uvicorn(path_with_query: str) -> list[str]:
    """Log one request through `uvicorn.access` exactly as uvicorn's protocols do."""
    import apps.api.main  # noqa: F401 - importing the app installs the filter

    out: list[str] = []

    class _Capture(logging.Handler):
        def emit(self, record):
            out.append(record.getMessage())

    logger = logging.getLogger("uvicorn.access")
    handler = _Capture()
    old_level, old_propagate = logger.level, logger.propagate
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    try:
        logger.info('%s - "%s %s HTTP/%s" %d', "10.0.0.1:5555", "GET", path_with_query, "1.1", 200)
    finally:
        logger.removeHandler(handler)
        logger.setLevel(old_level)
        logger.propagate = old_propagate
    return out


def test_access_log_drops_query_string_credentials():
    [line] = _emit_like_uvicorn("/hls/raw/p/a/v/720p.m3u8?token=SECRET-HLS-JWT")
    assert "SECRET-HLS-JWT" not in line
    assert '"GET /hls/raw/p/a/v/720p.m3u8 HTTP/1.1" 200' in line

    [line] = _emit_like_uvicorn("/events/0b9e?token=SECRET-ACCESS-JWT")
    assert "SECRET-ACCESS-JWT" not in line

    [line] = _emit_like_uvicorn("/share/abc/stream?share_session=SECRET-SESSION&version_id=1")
    assert "SECRET-SESSION" not in line
    # The share token in the path is redacted too (see the next test).
    assert '"GET /share/<redacted>/stream HTTP/1.1"' in line


def test_access_log_keeps_a_path_without_a_query_string():
    [line] = _emit_like_uvicorn("/health")
    assert line == '10.0.0.1:5555 - "GET /health HTTP/1.1" 200'


def test_access_log_redacts_tokens_carried_in_the_path():
    """An invite token in the path lets whoever holds it set the account's
    password, and a share token opens the link; neither goes into the log."""
    [line] = _emit_like_uvicorn("/auth/invite/SECRET-INVITE-TOKEN")
    assert "SECRET-INVITE-TOKEN" not in line
    assert '"GET /auth/invite/<redacted> HTTP/1.1"' in line

    [line] = _emit_like_uvicorn("/share/SECRET-SHARE-TOKEN/assets/0b9e?share_session=S")
    assert "SECRET-SHARE-TOKEN" not in line and "share_session" not in line
    assert '"GET /share/<redacted>/assets/0b9e HTTP/1.1"' in line

    [line] = _emit_like_uvicorn("/share/SECRET-SHARE-TOKEN")
    assert '"GET /share/<redacted> HTTP/1.1"' in line


def test_access_log_leaves_other_paths_alone():
    [line] = _emit_like_uvicorn("/projects/0b9e/share-links")
    assert '"GET /projects/0b9e/share-links HTTP/1.1"' in line
    [line] = _emit_like_uvicorn("/auth/invite")
    assert '"GET /auth/invite HTTP/1.1"' in line
