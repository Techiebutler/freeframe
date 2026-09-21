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
