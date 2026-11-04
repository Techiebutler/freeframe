"""P6 backend: dictation (Groq) and Telegram (link, webhook, owner pushes). All no-ops without their secrets."""
import uuid
from unittest.mock import MagicMock, patch

import pytest

from .agent_pg import env, needs_pg  # noqa: F401


class FakeRedis:
    def __init__(self):
        self.data = {}

    def setex(self, key, ttl, value):
        self.data[key] = value

    def get(self, key):
        return self.data.get(key)

    def getdel(self, key):
        return self.data.pop(key, None)


@pytest.fixture
def tg(monkeypatch):
    from apps.api.config import settings
    fake = FakeRedis()
    monkeypatch.setattr(settings, "telegram_bot_token", "123:abc")
    monkeypatch.setattr(settings, "telegram_bot_username", "autoreview_bot")
    monkeypatch.setattr(settings, "telegram_webhook_secret", "s3cret")
    with patch("apps.api.services.telegram.get_redis", return_value=fake), \
         patch("apps.api.services.telegram._post") as post:
        yield MagicMock(post=post, redis=fake)


# ── Dictation (mock DB, no Postgres needed) ───────────────────────────────────

def test_dictation_without_a_key_is_503(client, auth_headers, monkeypatch):
    from apps.api.config import settings
    monkeypatch.setattr(settings, "groq_api_key", None)
    r = client.post("/dictate", files={"audio": ("a.webm", b"123", "audio/webm")}, headers=auth_headers)
    assert (r.status_code, r.json()["detail"]) == (503, "dictation_unavailable")


def test_dictation_sends_the_audio_to_groq_whisper_turbo(client, auth_headers, monkeypatch):
    from apps.api.config import settings
    monkeypatch.setattr(settings, "groq_api_key", "gsk_test")
    reply = MagicMock(status_code=200)
    reply.json.return_value = {"text": " Hook ist zu langsam. Musik lauter.", "segments": [
        {"start": 0.0, "end": 1.8, "text": " Hook ist zu langsam."}, {"start": 1.8, "end": 3.0, "text": " Musik lauter."}, {"start": 3.0, "end": 3.1, "text": " "}]}
    with patch("apps.api.services.dictation.httpx.post", return_value=reply) as post:
        r = client.post("/dictate", files={"audio": ("a.webm", b"123", "audio/webm")}, headers=auth_headers)
    assert r.status_code == 200 and r.json() == {"text": "Hook ist zu langsam. Musik lauter.", "segments": [
        {"start": 0.0, "end": 1.8, "text": "Hook ist zu langsam."}, {"start": 1.8, "end": 3.0, "text": "Musik lauter."}]}
    assert post.call_args.args[0] == "https://api.groq.com/openai/v1/audio/transcriptions"
    assert post.call_args.kwargs["headers"]["Authorization"] == "Bearer gsk_test"
    assert post.call_args.kwargs["data"]["model"] == "whisper-large-v3-turbo"
    assert post.call_args.kwargs["data"]["response_format"] == "verbose_json"


def test_dictation_needs_login(client):
    assert client.post("/dictate", files={"audio": ("a.webm", b"1", "audio/webm")}).status_code == 401


def test_dictation_failure_is_a_visible_502(client, auth_headers, monkeypatch):
    from apps.api.config import settings
    monkeypatch.setattr(settings, "groq_api_key", "gsk_test")
    with patch("apps.api.services.dictation.httpx.post", return_value=MagicMock(status_code=500)):
        assert client.post("/dictate", files={"audio": ("a.webm", b"1", "audio/webm")}, headers=auth_headers).status_code == 502


# ── Telegram ──────────────────────────────────────────────────────────────────

def test_link_needs_a_configured_bot(client, auth_headers, monkeypatch):
    from apps.api.config import settings
    monkeypatch.setattr(settings, "telegram_bot_username", None)
    assert client.post("/me/telegram/link", headers=auth_headers).status_code == 503


def test_webhook_rejects_a_missing_or_wrong_secret(client, tg):
    body = {"message": {"text": "/start abc", "chat": {"id": 42}}}
    assert client.post("/telegram/webhook", json=body).status_code == 401
    assert client.post("/telegram/webhook", json=body, headers={"X-Telegram-Bot-Api-Secret-Token": "nope"}).status_code == 401


@needs_pg
def test_link_then_start_binds_the_chat_to_the_user(env, tg):
    r = env.client.post("/me/telegram/link", headers=env.headers(env.owner))
    assert r.status_code == 200
    url = r.json()["url"]
    assert url.startswith("https://t.me/autoreview_bot?start=")
    code = url.split("start=")[1]
    hook = {"X-Telegram-Bot-Api-Secret-Token": "s3cret"}
    assert env.client.post("/telegram/webhook", json={"message": {"text": f"/start {code}", "chat": {"id": 777}}}, headers=hook).json() == {"ok": True}
    from apps.api.models.user import User
    with env.Session() as db:
        assert db.get(User, env.owner.id).preferences["telegram_chat_id"] == "777"
    # the code is single use; an unknown /start or other chatter is ignored but still 200
    again = env.client.post("/telegram/webhook", json={"message": {"text": f"/start {code}", "chat": {"id": 888}}}, headers=hook)
    assert again.status_code == 200
    with env.Session() as db:
        assert db.get(User, env.owner.id).preferences["telegram_chat_id"] == "777"
    assert env.client.post("/telegram/webhook", json={"edited_message": {}}, headers=hook).status_code == 200


def test_send_is_a_no_op_without_a_bot_token(monkeypatch):
    from apps.api.config import settings
    from apps.api.services import telegram
    monkeypatch.setattr(settings, "telegram_bot_token", None)
    with patch("apps.api.services.telegram._post") as post:
        telegram.send("1", "hi")
    post.assert_not_called()


@needs_pg
def test_owner_with_a_chat_gets_one_push_when_the_agent_hand_in_is_clear(env, tg):
    from apps.api.models.user import User
    with env.Session() as db:
        o = db.get(User, env.owner.id)
        o.preferences = {"telegram_chat_id": "777"}
        db.commit()
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner, "Hook tests")
    one = env.asset(req, "Hook 1", by=agent.who)
    ok = {str(one.id): {"version_id": str(one.versions[0].id), "reviewed": True, "openMustFix": 0}}
    with patch("apps.api.services.review_bridge.asset_stats", return_value=ok), \
         patch("apps.api.services.review_bridge.request_status", return_value={req.review_share_token: {"status": "clear", "openMustFixes": 0}}):
        env.client.get("/agent/queue", headers=agent.headers)
        env.client.get("/agent/queue", headers=agent.headers)
    assert tg.post.call_count == 1
    chat, text = tg.post.call_args.args[0], tg.post.call_args.args[1]
    assert chat == "777" and "Hook tests" in text
    assert f"/projects/{env.project_a.id}/review?folder={req.folder_id}" in text


def test_dictate_is_a_plain_def_so_the_blocking_groq_call_runs_in_the_threadpool():
    import inspect
    from apps.api.routers.mobile import dictate
    assert not inspect.iscoroutinefunction(dictate)


def test_webhook_with_a_broken_body_is_400(client, tg):
    r = client.post("/telegram/webhook", content=b"{nope", headers={"X-Telegram-Bot-Api-Secret-Token": "s3cret", "content-type": "application/json"})
    assert r.status_code == 400


# ── Guests: POST /share/{token}/dictate ───────────────────────────────────────

def _groq(monkeypatch):
    from apps.api.config import settings
    monkeypatch.setattr(settings, "groq_api_key", "gsk_test")
    reply = MagicMock(status_code=200)
    reply.json.return_value = {"text": "Mehr Musik", "segments": [{"start": 0.0, "end": 1.0, "text": "Mehr Musik"}]}
    return patch("apps.api.services.dictation.httpx.post", return_value=reply)


def _share(permission):
    from apps.api.models.share import SharePermission
    link = MagicMock()
    link.permission = SharePermission(permission)
    return patch("apps.api.routers.mobile.validate_share_link_with_session", return_value=link)


AUDIO = {"audio": ("a.webm", b"123", "audio/webm")}


def test_guest_dictates_on_a_link_that_allows_comments(client, monkeypatch):
    with _groq(monkeypatch), _share("comment"):
        r = client.post("/share/tok/dictate?share_session=abc", files=AUDIO)
    assert r.status_code == 200 and r.json() == {"text": "Mehr Musik", "segments": [{"start": 0.0, "end": 1.0, "text": "Mehr Musik"}]}


def test_guest_dictation_is_refused_on_a_view_only_link(client, monkeypatch):
    with _groq(monkeypatch) as groq, _share("view"):
        r = client.post("/share/tok/dictate", files=AUDIO)
    assert r.status_code == 403
    groq.assert_not_called()


def test_guest_dictation_on_an_unknown_link_is_404(client, monkeypatch):
    from fastapi import HTTPException
    with _groq(monkeypatch) as groq, patch("apps.api.routers.mobile.validate_share_link_with_session", side_effect=HTTPException(404, "Share link not found")):
        assert client.post("/share/nope/dictate", files=AUDIO).status_code == 404
    groq.assert_not_called()


def test_guest_dictation_without_a_key_is_503_and_rate_limited_per_token(client, monkeypatch):
    from apps.api.config import settings
    monkeypatch.setattr(settings, "groq_api_key", None)
    with _share("comment"):
        r = client.post("/share/tok/dictate", files=AUDIO)
        assert (r.status_code, r.json()["detail"]) == (503, "dictation_unavailable")
        with patch("apps.api.routers.mobile.check_rate_limit", return_value=(False, 30)) as rl:
            assert client.post("/share/tok/dictate", files=AUDIO).status_code == 429
        assert rl.call_args.args[1] == "share_dictate:tok" and rl.call_args.args[2:] == (30, 600)
