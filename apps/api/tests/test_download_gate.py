"""The download gate (spec 2026-11-19-download-after-approval): a delivery opens it, the owner and the engine pass."""
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

from apps.api.models.project import ProjectRole
from apps.api.services import download_gate


def _db(delivered: bool):
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = object() if delivered else None
    return db


def test_gate(monkeypatch):
    p, v = uuid.uuid4(), uuid.uuid4()
    roles = {"owner@x": ProjectRole.owner, "editor@x": ProjectRole.editor, "reviewer@x": ProjectRole.reviewer}
    monkeypatch.setattr(download_gate, "effective_project_role", lambda db, pid, u: roles.get(u.email))
    monkeypatch.setattr(download_gate.settings, "service_api_key_email", "engine@x")
    user = lambda e: SimpleNamespace(email=e)

    # Before approval: nobody but the owner (draft) and the review engine.
    assert download_gate.may_download(_db(False), p, v, None) is False
    assert download_gate.may_download(_db(False), p, v, user("editor@x")) is False
    assert download_gate.may_download(_db(False), p, v, user("reviewer@x")) is False
    assert download_gate.may_download(_db(False), p, v, user("owner@x")) is True
    assert download_gate.may_download(_db(False), p, v, user("engine@x")) is True
    # After approval (a delivery exists): everyone the share already lets in.
    assert download_gate.may_download(_db(True), p, v, None) is True
    assert download_gate.may_download(_db(True), p, v, user("editor@x")) is True


def test_engine_needs_a_configured_service_email(monkeypatch):
    monkeypatch.setattr(download_gate.settings, "service_api_key_email", None)
    assert download_gate.is_engine(SimpleNamespace(email=None)) is False
