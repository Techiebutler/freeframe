"""Image in comment (spec 2026-11-07): confirmed uploads only, own comments only, rounds wait for images."""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from .agent_pg import env, needs_pg  # noqa: F401
from .test_level_up_api import link

pytestmark = needs_pg
PNG = {"file_name": "ref shot.png", "file_size": 2048, "content_type": "image/png"}
HEAD = "apps.api.services.s3_service.head_object"


def comment(e, a, expected=0, headers=None):
    body = {"version_id": str(a.versions[-1].id), "body": "Like this frame", "timecode_start": 2.0, "attachments_expected": expected}
    r = e.client.post(f"/assets/{a.id}/comments", json=body, headers=headers or e.headers(e.owner))
    assert r.status_code == 201, r.text
    return r.json()["id"]


def attach(e, cid, headers=None, body=PNG):
    return e.client.post(f"/comments/{cid}/attachments", json=body, headers=headers or e.headers(e.owner))


def listed(e, a):
    return e.client.get(f"/assets/{a.id}/comments", headers=e.headers(e.owner)).json()


def test_only_images_up_to_10_mb_and_4_per_comment(env):
    a = env.asset(env.request(env.project_a, env.owner))
    cid = comment(env, a)
    assert attach(env, cid, body={**PNG, "content_type": "video/mp4"}).status_code == 422
    assert attach(env, cid, body={**PNG, "file_size": 11 * 1024 * 1024}).status_code == 422
    assert all(attach(env, cid, body={**PNG, "file_name": f"ref {i}.png"}).status_code == 201 for i in range(4))
    assert attach(env, cid, body={**PNG, "file_name": "ref 5.png"}).status_code == 422


def test_an_image_exists_only_after_complete_and_complete_is_idempotent(env):
    a = env.asset(env.request(env.project_a, env.owner))
    cid = comment(env, a, expected=1)
    aid = attach(env, cid).json()["attachment_id"]
    assert listed(env, a)[0]["attachments"] == []
    with patch(HEAD, return_value=None):
        assert env.client.post(f"/comments/{cid}/attachments/{aid}/complete", headers=env.headers(env.owner)).status_code == 409
    with patch(HEAD, return_value=(2048, "image/png")):
        for _ in range(2):
            assert env.client.post(f"/comments/{cid}/attachments/{aid}/complete", headers=env.headers(env.owner)).status_code == 200
    assert [x["id"] for x in listed(env, a)[0]["attachments"]] == [aid]


def test_retry_reuses_the_same_row(env):
    from apps.api.models.comment import CommentAttachment
    a = env.asset(env.request(env.project_a, env.owner))
    cid = comment(env, a, expected=1)
    aid = attach(env, cid).json()["attachment_id"]
    again = env.client.post(f"/comments/{cid}/attachments/{aid}/retry", headers=env.headers(env.owner))
    assert again.status_code == 200 and again.json()["attachment_id"] == aid
    assert attach(env, cid).json()["attachment_id"] == aid  # the outbox resending the same file
    with env.Session() as db:
        assert db.query(CommentAttachment).count() == 1


def test_someone_else_may_not_attach_to_my_comment(env):
    from apps.api.models.project import ProjectMember, ProjectRole
    a = env.asset(env.request(env.project_a, env.owner))
    cid = comment(env, a)
    viewer = env.user("Viewer")
    with env.Session() as db:
        db.add(ProjectMember(project_id=env.project_a.id, user_id=viewer.id, role=ProjectRole.reviewer))
        db.commit()
    assert attach(env, cid, headers=env.headers(viewer)).status_code == 403


def test_a_guest_attaches_only_to_their_own_comment_through_a_comment_link(env):
    req = env.request(env.project_a, env.owner)
    a = env.asset(req)
    token = link(env, req.folder_id, "comment")
    body = {"asset_id": str(a.id), "version_id": str(a.versions[0].id), "body": "Like this", "guest_name": "Anna",
            "guest_email": "anna@example.test", "attachments_expected": 1}
    cid = env.client.post(f"/share/{token}/comment", json=body).json()["id"]
    url = f"/share/{token}/comments/{cid}/attachments"
    assert env.client.post(url, json={**PNG, "guest_email": "bob@example.test"}).status_code == 403
    assert env.client.post(url, json={**PNG, "guest_email": "anna@example.test"}).status_code == 201
    view_only = link(env, req.folder_id, "view")
    assert env.client.post(f"/share/{view_only}/comments/{cid}/attachments", json={**PNG, "guest_email": "anna@example.test"}).status_code == 403


def test_a_round_waits_for_images_then_exports_them(env):
    from apps.api.models.comment import Comment
    from apps.api.services import feedback_rounds as fr
    req = env.request(env.project_a, env.owner)
    a = env.asset(req)
    cid = comment(env, a, expected=1)
    aid = attach(env, cid).json()["attachment_id"]
    close = lambda: env.client.post(f"/requests/{req.id}/feedback-rounds/close", json={}, headers=env.headers(env.owner))
    r = close()
    assert r.status_code == 409 and r.json()["detail"] == {"error": "images_pending", "comment_ids": [cid]}
    # 15 minutes later it is images_failed - still not consumed, never dropped by time alone
    from apps.api.models.agent import FeedbackRound
    with env.Session() as db:
        db.get(Comment, uuid.UUID(cid)).created_at = datetime.now(timezone.utc) - timedelta(minutes=20)
        db.query(FeedbackRound).update({FeedbackRound.opened_at: datetime.now(timezone.utc) - timedelta(minutes=30)})
        db.commit()
        assert fr.close_idle(db, datetime.now(timezone.utc) + timedelta(hours=1)) == 0
    assert close().status_code == 409
    # a late confirmation still counts
    with patch(HEAD, return_value=(2048, "image/png")):
        assert env.client.post(f"/comments/{cid}/attachments/{aid}/complete", headers=env.headers(env.owner)).status_code == 200
    out = close()
    assert out.status_code == 200, out.text
    note = out.json()["files"][0]["comments"][0]
    assert [x["attachment_id"] for x in note["attachments"]] == [aid] and note["attachments"][0]["content_type"] == "image/png"


def test_send_without_the_missing_image_is_the_authors_explicit_choice(env):
    req = env.request(env.project_a, env.owner)
    a = env.asset(req)
    cid = comment(env, a, expected=2)
    attach(env, cid)
    r = env.client.post(f"/comments/{cid}/attachments/send-without-missing", headers=env.headers(env.owner))
    assert r.json() == {"attachments_expected": 0, "removed": 1}
    assert env.client.post(f"/requests/{req.id}/feedback-rounds/close", json={}, headers=env.headers(env.owner)).status_code == 200


def test_comment_state_is_pure():
    from apps.api.services.comment_attachments import comment_state
    t0 = datetime(2026, 11, 8, tzinfo=timezone.utc)
    assert [comment_state(1, 0, t0, t0 + timedelta(minutes=m)) for m in (1, 16)] == ["pending", "images_failed"]
    assert comment_state(1, 1, t0, t0 + timedelta(days=2)) == "ready"
