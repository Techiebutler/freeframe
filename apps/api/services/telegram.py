"""Telegram pushes to owners. Every function is a no-op without TELEGRAM_BOT_TOKEN."""
import logging
import secrets
import uuid
from typing import Optional

import httpx
from sqlalchemy.orm import Session

from ..config import settings
from ..models.user import User
from .redis_service import get_redis

logger = logging.getLogger("apps.api.telegram")
LINK_PREFIX = "tg_link:"
LINK_TTL = 15 * 60


def _post(chat_id: str, text: str) -> None:
    httpx.post(f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage",
               json={"chat_id": chat_id, "text": text, "disable_web_page_preview": True}, timeout=5).raise_for_status()


def send(chat_id: str, text: str) -> None:
    if not settings.telegram_bot_token:
        return
    try:
        _post(chat_id, text)
    except Exception:  # noqa: BLE001 - a failed push must never fail the request that triggered it
        logger.warning("telegram send failed", exc_info=True)


def link_url(user_id: uuid.UUID) -> str:
    code = secrets.token_urlsafe(12)
    get_redis().setex(f"{LINK_PREFIX}{code}", LINK_TTL, str(user_id))
    return f"https://t.me/{settings.telegram_bot_username}?start={code}"


def bind_chat(db: Session, code: str, chat_id: int) -> bool:
    """Single use: the code is gone after the first /start that carries it."""
    user_id = get_redis().getdel(f"{LINK_PREFIX}{code}")  # atomic: two /start with one code cannot both bind
    if not user_id:
        return False
    user = db.get(User, uuid.UUID(user_id))
    if user is None:
        return False
    user.preferences = {**(user.preferences or {}), "telegram_chat_id": str(chat_id)}
    db.commit()
    return True


def chat_id_of(user: User) -> Optional[str]:
    return (user.preferences or {}).get("telegram_chat_id")
