"""The request's review link (the one sent to reviewers, clients included) can approve."""
import uuid
from datetime import datetime, timedelta, timezone

from .agent_pg import env, needs_pg  # noqa: F401

pytestmark = needs_pg


def _review_link(e, req_id):
    from apps.api.models.share import ShareLink
    from apps.api.models.upload_request import UploadRequest
    with e.Session() as db:
        req = db.get(UploadRequest, req_id)
        return db.query(ShareLink).filter(ShareLink.token == req.review_share_token).one()


def _make_link(e, req, permission):
    from apps.api.models.share import ShareLink, SharePermission
    with e.Session() as db:
        link = ShareLink(folder_id=req.folder_id, token=req.review_share_token, created_by=e.owner.id, title="Auto Review",
                         permission=SharePermission(permission), visibility="public", allow_download=True)
        db.add(link)
        db.commit()
    return req.review_share_token


def test_a_new_request_gets_an_approve_review_link(env):
    r = env.client.post("/requests", json={"project_id": str(env.project_a.id), "title": "Spring"}, headers=env.headers(env.owner))
    assert r.status_code == 201, r.text
    link = _review_link(env, uuid.UUID(r.json()["id"]))
    assert link.permission.value == "approve"
    assert link.allow_download is True


def test_an_agent_created_request_gets_an_approve_review_link(env):
    agent = env.pair_agent(env.project_a)
    r = env.client.post("/agent/requests", json={"title": "Hook 1", "external_ref": "c-1"}, headers=agent.headers)
    assert r.status_code == 200, r.text
    assert _review_link(env, uuid.UUID(r.json()["request_id"])).permission.value == "approve"


def test_a_guest_approves_through_the_review_link_with_the_same_server_path(env):
    from unittest.mock import patch
    req = env.request(env.project_a, env.owner)
    token = _make_link(env, req, "approve")
    hooks = [env.asset(req, "Hook 1"), env.asset(req, "Hook 2")]
    out = []
    with patch("apps.api.routers.share_approval.deliveries.on_approved", wraps=__import__("apps.api.services.deliveries", fromlist=["x"]).on_approved) as spy:
        for a in hooks:
            r = env.client.post(f"/share/{token}/assets/{a.id}/approve", json={})
            assert r.status_code == 200, r.text
            out.append(r.json())
        assert spy.call_count == 2
    assert out[0]["parts"]["approved"] == 1 and out[0]["parts"]["total"] == 2 and out[0]["delivery"] is None
    assert out[1]["parts"]["complete"] is True and out[1]["delivery"]["share_url"].endswith(f"/d/{out[1]['delivery']['token']}")


def test_the_embed_does_not_reuse_the_review_link(env):
    from apps.api.services import agent_queue
    req = env.request(env.project_a, env.owner)
    review = _make_link(env, req, "approve")
    with env.Session() as db:
        url = agent_queue.embed_url(db, req, env.owner.id)
        db.commit()
    assert review not in url


def test_existing_comment_review_links_still_find_their_request(env):
    # ensure_folder_assignment accepts the standing link whichever permission it has
    from apps.api.models.folder import Folder
    from apps.api.models.project import Project
    from apps.api.routers.requests import ensure_folder_assignment
    from apps.api.models.share import ShareLink, SharePermission
    for perm in ("comment", "approve"):
        with env.Session() as db:
            f = Folder(project_id=env.project_a.id, name=f"F {perm}", created_by=env.owner.id)
            db.add(f)
            db.flush()
            db.add(ShareLink(folder_id=f.id, token=uuid.uuid4().hex, created_by=env.owner.id, title="Auto Review",
                             permission=SharePermission(perm), visibility="public", allow_download=True))
            db.flush()
            req, _ = ensure_folder_assignment(db, f, db.get(Project, env.project_a.id), env.owner.id)
            assert req.review_share_token


def _run(env, *args):
    from apps.api.scripts import upgrade_review_links_approve as s
    with env.Session() as db:
        return s.run(db, go="--go" in args)


def test_backfill_dry_run_writes_nothing_and_go_upgrades_only_open_review_links(env):
    from apps.api.models.share import ShareLink, SharePermission
    from apps.api.models.upload_request import UploadRequest
    open_req = env.request(env.project_a, env.owner, "Open")
    revoked = env.request(env.project_a, env.owner, "Revoked")
    done = env.request(env.project_a, env.owner, "Done")
    viewonly = env.request(env.project_a, env.owner, "View")
    stale = env.request(env.project_a, env.owner, "Stale")   # open, but nothing happened for 30 days
    for r, perm in ((open_req, "comment"), (revoked, "comment"), (done, "comment"), (viewonly, "view"), (stale, "comment")):
        _make_link(env, r, perm)
    with env.Session() as db:
        db.get(UploadRequest, revoked.id).revoked_at = datetime.now(timezone.utc)
        db.get(UploadRequest, done.id).completed_at = datetime.now(timezone.utc)
        db.get(UploadRequest, stale.id).created_at = datetime.now(timezone.utc) - timedelta(days=30)
        db.commit()

    def perms():
        with env.Session() as db:
            return {t: db.query(ShareLink).filter(ShareLink.token == t).one().permission.value
                    for t in (open_req.review_share_token, revoked.review_share_token, done.review_share_token, viewonly.review_share_token, stale.review_share_token)}

    before = perms()
    assert _run(env) == 1
    assert perms() == before
    assert _run(env, "--go") == 1
    after = perms()
    assert after[open_req.review_share_token] == "approve"
    assert after[revoked.review_share_token] == "comment" and after[done.review_share_token] == "comment"
    assert after[viewonly.review_share_token] == "view"
    assert after[stale.review_share_token] == "comment"
    assert _run(env, "--go") == 0
