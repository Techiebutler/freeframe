"""The embed preview of a module request shows its separate parts: each carries its role and place (2026-11-16)."""
from apps.api.routers.share import part_roles

MANIFEST = {"slots": [
    {"id": "h1", "role": "hook"}, {"id": "h2", "role": "hook"}, {"id": "h3", "role": "hook"},
    {"id": "b1", "role": "body"}, {"id": "c1", "role": "cta"},
]}
STATE = {"slots": {k: {"asset_id": f"asset-{k}"} for k in ("h1", "h2", "h3", "b1", "c1")}}


def test_each_part_gets_role_and_order_within_its_role():
    assert part_roles(MANIFEST, STATE) == {
        "asset-h1": ("hook", 0), "asset-h2": ("hook", 1), "asset-h3": ("hook", 2),
        "asset-b1": ("body", 0), "asset-c1": ("cta", 0)}


def test_a_slot_without_an_upload_yet_is_skipped_but_still_counts_for_order():
    state = {"slots": {"h2": {"asset_id": "asset-h2"}}}
    assert part_roles(MANIFEST, state) == {"asset-h2": ("hook", 1)}


def test_no_module_data_means_no_roles():
    assert part_roles(None, None) == {}
    assert part_roles({"slots": []}, {}) == {}
    assert part_roles({"slots": [{"id": "x"}]}, {"slots": {"x": {"asset_id": "a"}}}) == {}


# ── the desk's embed link is not the request's review link ────────────────────────────────────────────────────────

import secrets  # noqa: E402

from .agent_pg import env, needs_pg  # noqa: E402,F401


@needs_pg
def test_a_second_share_link_on_the_folder_still_gets_roles_and_lists_the_parts(env):
    from apps.api.models.asset import Asset
    from apps.api.models.share import ShareLink, SharePermission
    from apps.api.models.upload_request import UploadRequest
    req = env.request(env.project_a, env.owner, "Glow ad")
    hooks = [env.asset(req, "Hook a"), env.asset(req, "Hook b")]
    body = env.asset(req, "Body v1")
    manifest = {"slots": [{"id": "h1", "role": "hook"}, {"id": "h2", "role": "hook"}, {"id": "b1", "role": "body"}]}
    with env.Session() as db:
        for a in (*hooks, body):
            db.get(Asset, a.id).iteration_source = True            # parts are only listed through links that may see them
        row = db.get(UploadRequest, req.id)
        row.iteration_manifest = manifest
        row.iteration_state = {"slots": {"h1": {"asset_id": str(hooks[0].id)}, "h2": {"asset_id": str(hooks[1].id)}, "b1": {"asset_id": str(body.id)}}}
        desk = ShareLink(folder_id=req.folder_id, token=secrets.token_urlsafe(16), created_by=env.owner.id, title="Gen review", permission=SharePermission.approve, visibility="public")
        db.add(desk)
        db.commit()
        token = desk.token
    assert token != req.review_share_token
    out = env.client.get(f"/share/{token}/assets?page=1&per_page=50&embed=true").json()
    got = {a["name"]: (a["role"], a["order"]) for a in out["assets"]}
    assert got == {"Hook a": ("hook", 0), "Hook b": ("hook", 1), "Body v1": ("body", 0)}


@needs_pg
def test_embed_true_does_not_widen_what_another_folder_share_shows(env):
    from apps.api.models.asset import Asset
    from apps.api.models.share import ShareLink, SharePermission
    from apps.api.models.upload_request import UploadRequest
    from datetime import datetime, timedelta, timezone
    req = env.request(env.project_a, env.owner, "Glow ad")
    part = env.asset(req, "Hook a")
    plain = env.asset(req, "Plain")
    t0 = datetime.now(timezone.utc)
    with env.Session() as db:
        db.get(Asset, part.id).iteration_source = True
        row = db.get(UploadRequest, req.id)
        row.iteration_manifest = {"slots": [{"id": "h1", "role": "hook"}]}
        row.iteration_state = {"slots": {"h1": {"asset_id": str(part.id)}}}
        desk = ShareLink(folder_id=req.folder_id, token=secrets.token_urlsafe(16), created_by=env.owner.id, title="Gen review",
                         permission=SharePermission.approve, visibility="public", created_at=t0)
        customer = ShareLink(folder_id=req.folder_id, token=secrets.token_urlsafe(16), created_by=env.owner.id, title="Customer",
                             permission=SharePermission.comment, visibility="public", created_at=t0 + timedelta(minutes=1))
        db.add_all([desk, customer])
        db.commit()
        desk_token, customer_token = desk.token, customer.token
    names = lambda t: sorted(a["name"] for a in env.client.get(f"/share/{t}/assets?page=1&per_page=50&embed=true").json()["assets"])  # noqa: E731
    assert names(desk_token) == ["Hook a", "Plain"]            # the request's embed link previews its parts
    assert names(customer_token) == ["Plain"]                  # any other link: same visibility as without the flag
