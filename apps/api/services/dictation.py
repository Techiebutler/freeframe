"""Speech to text for comments: Groq whisper-large-v3-turbo, same model as Gen's /api/dictate."""
import httpx
from fastapi import HTTPException

from ..config import settings

GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
MODEL = "whisper-large-v3-turbo"
MAX_BYTES = 25 * 1024 * 1024


def transcribe(audio: bytes, filename: str, content_type: str) -> dict:
    if not settings.groq_api_key:
        raise HTTPException(503, "dictation_unavailable")
    if len(audio) > MAX_BYTES:
        raise HTTPException(413, "audio_too_large")
    try:
        r = httpx.post(GROQ_URL, headers={"Authorization": f"Bearer {settings.groq_api_key}"},
                       data={"model": MODEL, "response_format": "verbose_json"},
                       files={"file": (filename or "audio.webm", audio, content_type or "audio/webm")}, timeout=60)
        if r.status_code != 200:
            raise HTTPException(502, "dictation_failed")
        body = r.json()
        segments = [{"start": float(x["start"]), "end": float(x["end"]), "text": str(x["text"]).strip()}
                    for x in body.get("segments") or [] if str(x.get("text", "")).strip()]
        return {"text": str(body.get("text", "")).strip(), "segments": segments}
    except httpx.HTTPError as error:
        raise HTTPException(502, "dictation_failed") from error
