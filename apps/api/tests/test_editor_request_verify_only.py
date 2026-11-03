"""A verify-only editor-request (adopt=false) must not submit files already in a reused folder.

Regression: a cancelled hand-in left Hook1 in the card folder; the restart's pre-upload "verify" call
adopted it and froze it as a submitted v1, so the review sat on "Preparing video" with only Hook1.
"""
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from apps.api.routers import requests as r


def _call(adopt: bool):
    folder = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4(), description='https://trello.com/c/QoBbPcQZ')
    project = SimpleNamespace(id=folder.project_id, is_workspace=True)
    db = MagicMock()
    db.query.return_value.filter.return_value.with_for_update.return_value.first.return_value = folder
    db.query.return_value.filter.return_value.populate_existing.return_value.with_for_update.return_value.first.return_value = project
    user = SimpleNamespace(id=uuid.uuid4(), is_staff=True)
    req = SimpleNamespace(id=uuid.uuid4())
    with patch.object(r, 'require_project_role'), \
         patch.object(r, 'ensure_folder_assignment', return_value=(req, None)), \
         patch.object(r, 'components', return_value=False), \
         patch.object(r, 'locked_request', return_value=req), \
         patch.object(r, '_submitted_assets', return_value=[]) as submitted, \
         patch.object(r, '_request_out', return_value={'ok': True}):
        out = r.folder_editor_request(folder.id, adopt=adopt, db=db, current_user=user)
    return out, submitted, db


def test_verify_only_does_not_adopt_existing_files():
    out, submitted, db = _call(adopt=False)
    assert out == {'ok': True}
    submitted.assert_not_called()
    db.commit.assert_called_once()


def test_default_call_still_adopts():
    _, submitted, _ = _call(adopt=True)
    submitted.assert_called_once()
