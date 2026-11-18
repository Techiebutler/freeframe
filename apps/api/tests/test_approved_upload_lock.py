"""An approved asset locks against new versions; a closed human round voids the approval (no DB needed)."""
import json
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.approval import Approval
from apps.api.models.asset import AssetVersion
from apps.api.services import approval_lock, feedback_rounds


def fake_db(newest, approved):
    """query(AssetVersion)...first() -> newest; query(Approval)...first() -> approved."""
    def q(first):
        m = MagicMock()
        m.filter.return_value = m
        m.order_by.return_value = m
        m.first.return_value = first
        return m
    versions, approvals = q(newest), q(approved)
    db = MagicMock()
    db.query.side_effect = lambda entity, *a: versions if entity is AssetVersion else approvals
    return db


def test_an_unapproved_newest_version_is_not_locked():
    v = MagicMock(id=uuid.uuid4())
    approval_lock.guard(fake_db(v, None), uuid.uuid4(), reopen=False)


def test_an_asset_without_versions_is_not_locked():
    approval_lock.guard(fake_db(None, None), uuid.uuid4(), reopen=False)


def test_an_approved_newest_version_refuses_a_new_one():
    v, aid = MagicMock(id=uuid.uuid4()), uuid.uuid4()
    with pytest.raises(approval_lock.AlreadyApproved) as err:
        approval_lock.guard(fake_db(v, MagicMock()), aid, reopen=False)
    assert (err.value.asset_id, err.value.version_id) == (aid, v.id)


def test_reopen_lets_it_through_without_looking():
    db = MagicMock()
    approval_lock.guard(db, uuid.uuid4(), reopen=True)
    db.query.assert_not_called()


def test_the_409_body_names_the_asset_version_and_the_way_out():
    aid, vid = uuid.uuid4(), uuid.uuid4()
    r = approval_lock.handler(None, approval_lock.AlreadyApproved(aid, vid))
    assert r.status_code == 409
    assert json.loads(r.body) == {"error": "already_approved", "asset_id": str(aid), "version_id": str(vid),
                                  "hint": "pass reopen=true to start a new version anyway"}


def test_the_app_maps_the_exception_to_409():
    from apps.api.main import app
    assert app.exception_handlers[approval_lock.AlreadyApproved] is approval_lock.handler


def test_every_initiate_body_takes_reopen_defaulting_to_false():
    from apps.api.routers.requests import GuestInitiate
    from apps.api.schemas.upload import InitiateUploadRequest
    assert GuestInitiate(original_filename="a.mp4", mime_type="video/mp4", file_size_bytes=1).reopen is False
    assert GuestInitiate(original_filename="a.mp4", mime_type="video/mp4", file_size_bytes=1, reopen=True).reopen is True
    body = dict(project_id=uuid.uuid4(), asset_name="a", original_filename="a.mp4", mime_type="video/mp4", file_size_bytes=1)
    assert InitiateUploadRequest(**body).reopen is False and InitiateUploadRequest(**body, reopen=True).reopen is True


def test_a_round_close_takes_back_the_approval_of_each_commented_version_once():
    asset, v1, v2 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    now = datetime.now(timezone.utc)
    comments = [MagicMock(asset_id=asset, version_id=v1, created_at=now), MagicMock(asset_id=asset, version_id=v1, created_at=now + timedelta(seconds=5)),
                MagicMock(asset_id=asset, version_id=v2, created_at=now)]
    u1, u2 = uuid.uuid4(), uuid.uuid4()
    db = MagicMock()
    db.get.return_value = MagicMock(id=asset)
    db.query.return_value.filter.return_value.all.return_value = [MagicMock(user_id=u1), MagicMock(user_id=u1), MagicMock(user_id=u2)]
    with patch("apps.api.routers.approvals.remove_approval") as undo:
        feedback_rounds.void_approvals_commented_after(db, comments)
    assert len(undo.call_args_list) == 4
    assert {(c.args[2], c.args[3]) for c in undo.call_args_list} == {(u1, v1), (u2, v1), (u1, v2), (u2, v2)}


def test_no_comments_no_undo():
    with patch("apps.api.routers.approvals.remove_approval") as undo:
        feedback_rounds.void_approvals_commented_after(MagicMock(), [])
    undo.assert_not_called()


def test_a_failing_undo_never_breaks_closing_the_round():
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = [MagicMock(user_id=uuid.uuid4())]
    with patch("apps.api.routers.approvals.remove_approval", side_effect=RuntimeError("boom")):
        feedback_rounds.void_approvals_commented_after(db, [MagicMock(asset_id=uuid.uuid4(), version_id=uuid.uuid4(), created_at=datetime.now(timezone.utc))])
    db.rollback.assert_called_once()
