"""Speech to text for comments: Groq whisper-large-v3-turbo, same model as Gen's /api/dictate.

Dictation v2 (docs/superpowers/specs/2026-11-09-review-dictation-v2.md): a fixed language (German unless told otherwise),
a vocabulary prompt built from the lexicon (Gen's lexicon.json), and word + segment timestamps for sentence anchoring.
"""
import json
from pathlib import Path

import httpx
from fastapi import HTTPException

from ..config import settings

GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
MODEL = "whisper-large-v3-turbo"
MAX_BYTES = 25 * 1024 * 1024
LANGS = {"de", "en", "auto"}
# Whisper reads about 224 tokens of prompt; ~800 characters of German/English words stay inside that.
MAX_PROMPT = 800
TERMS = [str(t).strip() for t in json.loads((Path(__file__).parent / "dictation_lexicon.json").read_text(encoding="utf-8"))["terms"] if str(t).strip()]


def build_prompt(hint: str = "", terms: list = TERMS, max_chars: int = MAX_PROMPT) -> str:
    """The Whisper prompt = hint, then the most important lexicon terms that fit whole within `max_chars` (Gen's buildPrompt rule)."""
    out = hint or ""
    sep = " " if out else ""
    first = True
    for term in terms:
        nxt = out + sep + term
        if len(nxt) > max_chars:
            break
        out, sep, first = nxt, ", ", False
    return "" if first and len(out) > max_chars else out


def transcribe(audio: bytes, filename: str, content_type: str, lang: str = "de") -> dict:
    lang = (lang or "de").lower()
    if lang not in LANGS:
        raise HTTPException(400, "bad_lang")
    if not settings.groq_api_key:
        raise HTTPException(503, "dictation_unavailable")
    if len(audio) > MAX_BYTES:
        raise HTTPException(413, "audio_too_large")
    data: dict = {"model": MODEL, "response_format": "verbose_json", "temperature": "0",
                  "timestamp_granularities[]": ["word", "segment"]}
    if lang != "auto":
        data["language"] = lang
    prompt = build_prompt()
    if prompt:
        data["prompt"] = prompt
    try:
        r = httpx.post(GROQ_URL, headers={"Authorization": f"Bearer {settings.groq_api_key}"}, data=data,
                       files={"file": (filename or "audio.webm", audio, content_type or "audio/webm")}, timeout=120)
        if r.status_code != 200:
            raise HTTPException(502, "dictation_failed")
        body = r.json()
        segments = [{"start": float(x["start"]), "end": float(x["end"]), "text": str(x["text"]).strip()}
                    for x in body.get("segments") or [] if str(x.get("text", "")).strip()]
        words = [{"start": float(x["start"]), "end": float(x["end"]), "word": str(x["word"]).strip()}
                 for x in body.get("words") or [] if str(x.get("word", "")).strip()]
        result = {"text": str(body.get("text", "")).strip(), "segments": segments}
        if words:  # absent when the provider sent none, so the response shape of v1 clients is unchanged
            result["words"] = words
        return result
    except httpx.HTTPError as error:
        raise HTTPException(502, "dictation_failed") from error
