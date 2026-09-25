"""`Settings.frontend_origin`: FRONTEND_URL reduced to the origin CORS can match.

A sub-path deployment sets FRONTEND_URL to a URL with a path so that the links
in emails point inside the mounted app. A browser's Origin header is scheme,
host and port and never carries a path, so the CORS allow-list has to be built
from the bare origin or no cross-origin request would ever match.
"""
from apps.api.config import settings


def test_path_is_stripped(monkeypatch):
    monkeypatch.setattr(settings, "frontend_url", "https://example.com/freeframe")
    assert settings.frontend_origin == "https://example.com"


def test_port_is_preserved(monkeypatch):
    monkeypatch.setattr(settings, "frontend_url", "http://192.168.1.50:8080/freeframe")
    assert settings.frontend_origin == "http://192.168.1.50:8080"


def test_root_url_is_unchanged(monkeypatch):
    monkeypatch.setattr(settings, "frontend_url", "https://example.com")
    assert settings.frontend_origin == "https://example.com"


def test_trailing_slash_is_stripped(monkeypatch):
    monkeypatch.setattr(settings, "frontend_url", "https://example.com/")
    assert settings.frontend_origin == "https://example.com"


def test_unparseable_value_falls_back_to_raw(monkeypatch):
    monkeypatch.setattr(settings, "frontend_url", "localhost:3000")
    assert settings.frontend_origin == "localhost:3000"


_PREFLIGHT_SCRIPT = """
import json

from fastapi.testclient import TestClient

from apps.api.main import app

response = TestClient(app).options(
    "/health",
    headers={
        "Origin": "https://example.com",
        "Access-Control-Request-Method": "GET",
    },
)
print(json.dumps({
    "status": response.status_code,
    "allow_origin": response.headers.get("access-control-allow-origin"),
}))
"""


def test_cors_preflight_allows_bare_origin():
    """The allow-list is built from `frontend_origin`, not the raw FRONTEND_URL.

    Guards the wiring in `main.py`, not just the property: a preflight from the
    pathless origin a browser sends must be allowed even though FRONTEND_URL
    carries the sub-path. Rebuilding the app with the raw URL makes this 400.

    Runs in a subprocess because `main.py` builds the middleware at import
    time — an in-process reload would leave every module that captured `app`
    holding a different object than the `client` fixture uses.
    """
    import json
    import os
    import subprocess
    import sys
    from pathlib import Path

    repo_root = Path(__file__).resolve().parents[3]
    # CORS_ALLOW_ORIGINS is pinned empty. A "*" inherited from the environment
    # or the repo-root .env switches main.py to allow_origin_regex=".*", and
    # the preflight would then pass against the raw FRONTEND_URL as well. An
    # environment variable wins over .env, so this covers both.
    env = {
        **os.environ,
        "FRONTEND_URL": "https://example.com/freeframe",
        "CORS_ALLOW_ORIGINS": "",
    }
    result = subprocess.run(
        [sys.executable, "-c", _PREFLIGHT_SCRIPT],
        cwd=repo_root,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    outcome = json.loads(result.stdout.strip().splitlines()[-1])

    assert outcome["status"] == 200
    assert outcome["allow_origin"] == "https://example.com"
