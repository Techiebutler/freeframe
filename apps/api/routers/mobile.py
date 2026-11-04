"""Mobile feedback backend: dictation and the Telegram link/webhook."""
import secrets
from typing import Any

from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..middleware.auth import get_current_user, get_optional_user
from ..middleware.rate_limit import rate_limit
from ..models.share import SharePermission
from ..models.user import User
from ..services.permissions import validate_share_link_with_session
from ..services.redis_service import check_rate_limit
from ..services import dictation, telegram

router = APIRouter(tags=["mobile"])


@router.post("/dictate", dependencies=[Depends(rate_limit("dictate", 60, 600))])
def dictate(audio: UploadFile = File(...), current_user: User = Depends(get_current_user)):
    # A plain def runs in the threadpool: the Groq call below is a blocking httpx request.
    data = audio.file.read(dictation.MAX_BYTES + 1)
    return dictation.transcribe(data, audio.filename or "", audio.content_type or "")


@router.post("/share/{token}/dictate")
def share_dictate(token: str, request: Request, audio: UploadFile = File(...), share_session: Optional[str] = Query(None),
                  db: Session = Depends(get_db), current_user: Optional[User] = Depends(get_optional_user)):
    """Dictation for a logged-out guest: only on a valid link that allows comments, throttled per token and IP."""
    link = validate_share_link_with_session(db, token, share_session=share_session, current_user=current_user)
    if link.permission == SharePermission.view:
        raise HTTPException(403, "This share link does not allow commenting")
    ip = request.headers.get("x-real-ip") or (request.client.host if request.client else "unknown")
    allowed, retry_after = check_rate_limit(ip, f"share_dictate:{token}", 30, 600)
    if not allowed:
        raise HTTPException(429, "Too many requests", headers={"Retry-After": str(retry_after)})
    data = audio.file.read(dictation.MAX_BYTES + 1)
    return dictation.transcribe(data, audio.filename or "", audio.content_type or "")


@router.post("/me/telegram/link")
def telegram_link(current_user: User = Depends(get_current_user)):
    if not settings.telegram_bot_username:
        raise HTTPException(503, "telegram_unavailable")
    return {"url": telegram.link_url(current_user.id)}


@router.post("/telegram/webhook")
async def telegram_webhook(request: Request, db: Session = Depends(get_db)):
    secret = settings.telegram_webhook_secret
    presented = request.headers.get("x-telegram-bot-api-secret-token", "")
    if not secret or not secrets.compare_digest(presented.encode(), secret.encode()):
        raise HTTPException(401, "invalid_secret")
    try:
        update: Any = await request.json()
    except ValueError:
        raise HTTPException(400, "invalid_json")
    message = update.get("message") if isinstance(update, dict) else None
    text = (message or {}).get("text") or ""
    chat = ((message or {}).get("chat") or {}).get("id")
    if chat is not None and text.startswith("/start "):
        ok = telegram.bind_chat(db, text.split(maxsplit=1)[1].strip(), chat)
        telegram.send(str(chat), "Connected. You will get a message here when a video is ready for your review." if ok
                      else "That link has expired. Create a new one in AutoReview.")
    return {"ok": True}
