"""The self-managing board: lanes, Done rules, agent silence. Pure functions, no database."""
from datetime import datetime, timedelta, timezone

from apps.api.services.board_lifecycle import gen_card_key, lane_of, lifecycle

NOW = datetime(2026, 11, 18, 12, 0, tzinfo=timezone.utc)


def life(**over):
    base = dict(last_activity=NOW - timedelta(hours=1), last_agent_activity=NOW - timedelta(hours=1), approved=False,
                delivered=False, stage="editor", is_agent=True)
    return lifecycle(NOW, **{**base, **over})


def test_lanes_follow_the_board():
    assert lane_of("live", 0, "reviewing", None) == "editor"
    assert lane_of("live", 1, "reviewing", None) == "review"
    assert lane_of("live", 1, "held", None) == "corrections"
    assert lane_of("live", 1, "clear", None) == "ready"
    assert lane_of("live", 1, "clear", "self_review") == "review"
    assert lane_of("live", 1, "held", "agent_stuck") == "corrections"
    assert lane_of("revoked", 1, "clear", None) == "closed"


def test_approved_and_delivered_are_done_at_once():
    assert life(approved=True)["done_reason"] == "approved"
    assert life(delivered=True, approved=True)["done_reason"] == "delivered"


def test_stale_after_14_days_and_reopens_on_new_activity():
    old = NOW - timedelta(days=14, minutes=1)
    assert life(last_activity=old, last_agent_activity=old)["done_reason"] == "stale"
    assert life(last_activity=NOW - timedelta(days=13, hours=23))["done_reason"] is None
    # a new upload/comment moves last_activity: nothing is stored, so the card is back
    assert life(last_activity=NOW - timedelta(minutes=5))["done_reason"] is None


def test_silent_agent_after_24h_in_agent_lanes_only():
    quiet = NOW - timedelta(hours=25)
    for stage in ("editor", "corrections"):
        r = life(stage=stage, last_agent_activity=quiet)
        assert r["stale_agent"] is True and r["agent_silent_since"] == quiet.isoformat()
    assert life(stage="editor", last_agent_activity=NOW - timedelta(hours=23))["stale_agent"] is False
    assert life(stage="ready", last_agent_activity=quiet)["stale_agent"] is False
    assert life(stage="review", last_agent_activity=quiet)["stale_agent"] is False


def test_humans_and_done_cards_are_never_flagged_silent():
    quiet = NOW - timedelta(hours=30)
    assert life(is_agent=False, last_agent_activity=quiet)["stale_agent"] is False
    assert life(approved=True, last_agent_activity=quiet)["stale_agent"] is False


def test_agent_activity_clears_the_flag():
    assert life(last_agent_activity=NOW - timedelta(minutes=1))["stale_agent"] is False


def test_gen_card_key_from_external_ref():
    assert gen_card_key("gen:card_abc-12") == "card_abc-12"
    assert gen_card_key("gen:") is None and gen_card_key("ref-9") is None and gen_card_key(None) is None
    assert gen_card_key("gen:bad key") is None


# ── Database-backed: the activity query against real rows ─────────────────────
from .agent_pg import env, needs_pg  # noqa: E402,F401


def _aged(env, req, asset, when):
    from apps.api.models.asset import AssetVersion
    from apps.api.models.upload_request import UploadRequest
    with env.Session() as db:
        for v in db.query(AssetVersion).filter(AssetVersion.asset_id == asset.id):
            v.created_at = when
        db.get(UploadRequest, req.id).created_at = when
        db.commit()


def _board(env, req):
    from apps.api.models.upload_request import UploadRequest
    from apps.api.services import board_lifecycle as b
    from apps.api.routers.requests import _submitted_assets
    now = datetime.now(timezone.utc)
    with env.Session() as db:
        r = db.get(UploadRequest, req.id)
        info = b.activity(db, [r], {r.id: _submitted_assets(db, r)})[r.id]
        return info, b.lifecycle(now, last_activity=info["last_activity"], last_agent_activity=info["last_agent_activity"],
                                 approved=False, delivered=False, stage="corrections", is_agent=info["is_agent"])


@needs_pg
def test_db_stale_after_14_days_then_new_upload_reopens(env):
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner, "Old hook")
    a = env.asset(req, by=agent.who)
    _aged(env, req, a, datetime.now(timezone.utc) - timedelta(days=15))
    info, life_ = _board(env, req)
    assert life_["done_reason"] == "stale" and info["worker"]["kind"] == "agent"
    env.asset(req, name="Hook 2", by=agent.who)  # new activity: a fresh version lands
    _, life_ = _board(env, req)
    assert life_["done_reason"] is None


@needs_pg
def test_db_agent_silent_after_24h_and_a_human_comment_does_not_clear_it(env):
    from apps.api.models.comment import Comment
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner, "Quiet hook")
    a = env.asset(req, by=agent.who)
    _aged(env, req, a, datetime.now(timezone.utc) - timedelta(hours=30))
    _, life_ = _board(env, req)
    assert life_["stale_agent"] is True and life_["done_reason"] is None
    with env.Session() as db:
        db.add(Comment(asset_id=a.id, version_id=a.versions[0].id, author_id=env.owner.id, body="Where is the fix?"))
        db.commit()
    info, life_ = _board(env, req)
    assert life_["stale_agent"] is True                       # human comment is activity, not agent activity
    assert datetime.now(timezone.utc) - info["last_activity"] < timedelta(minutes=5)
