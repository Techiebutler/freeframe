"""Speech to text for comments: Groq whisper-large-v3-turbo, same model as Gen's /api/dictate.

Dictation v2 (docs/superpowers/specs/2026-11-09-review-dictation-v2.md): a fixed language (German unless told otherwise),
a vocabulary prompt built from the lexicon (Gen's lexicon.json), and word + segment timestamps for sentence anchoring.
"""
import difflib
import json
from pathlib import Path
from typing import Optional

import httpx
from fastapi import HTTPException

from ..config import settings

GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
MODEL = "whisper-large-v3-turbo"
CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
FIXUP_MODEL = "llama-3.1-8b-instant"
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


def fix_terms(text: str) -> str:
    """Cheap second pass on the same Groq key: repairs misheard lexicon words only ("Chatsuki" -> "ChatGPT"). Any failure keeps `text`."""
    if not text or not settings.groq_api_key:
        return text
    system = ("You fix speech-to-text errors in a short German/English video-review note. Replace only words that were clearly misheard "
              "versions of a term from the vocabulary. Never rephrase, translate, add or remove anything else. Reply with the note only.\n"
              "Vocabulary: " + ", ".join(TERMS))
    try:
        r = httpx.request("POST", CHAT_URL, headers={"Authorization": f"Bearer {settings.groq_api_key}"}, timeout=20,
                       json={"model": FIXUP_MODEL, "temperature": 0, "messages": [{"role": "system", "content": system}, {"role": "user", "content": text}]})
        fixed = str(r.json()["choices"][0]["message"]["content"]).strip() if r.status_code == 200 else ""
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError):
        return text
    # A reply far off the original length is a rephrase or an answer, not a fix.
    return fixed if fixed and 0.7 <= len(fixed) / len(text) <= 1.4 else text


def _fix_words(swaps: list, words: list) -> None:
    """The same swaps on the word list (agents read the words next to the audio): equal length swaps replace word by word,
    a different length collapses the matched words into one that spans their time."""
    i = 0
    while i < len(words):
        for src, dst in swaps:
            n = len(src)
            if [w["word"] for w in words[i:i + n]] == src:
                if len(dst) == n:
                    for w, new in zip(words[i:i + n], dst):
                        w["word"] = new
                else:
                    words[i:i + n] = [{"start": words[i]["start"], "end": words[i + n - 1]["end"], "word": " ".join(dst)}]
                break
        i += 1


def apply_fixes(raw: str, fixed: str, segments: list, words: Optional[list] = None) -> list:
    """Carry the fix-up into the segments (the embed builds notes from them): each 'replace' between raw and fixed tokens is applied
    to a segment's text when its whole token sequence sits inside that segment. Timings are untouched. `words` (when given) get the
    same fix in place, so the stored words and the text agree."""
    a, b = raw.split(), fixed.split()
    swaps = [(a[i1:i2], b[j1:j2]) for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes() if op == "replace"]
    if words:
        _fix_words(swaps, words)
    for seg in segments:
        toks = seg["text"].split()
        for src, dst in swaps:
            n = len(src)
            for i in range(len(toks) - n + 1):
                if toks[i:i + n] == src:
                    toks[i:i + n] = dst
                    break
        seg["text"] = " ".join(toks)
    return segments


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
        raw = str(body.get("text", "")).strip()
        text = fix_terms(raw)
        result = {"text": text, "segments": segments}
        if text != raw:
            apply_fixes(raw, text, segments, words)
        if text != raw:  # the raw Whisper text stays available; absent when nothing was fixed
            result["raw_text"] = raw
        if words:  # absent when the provider sent none, so the response shape of v1 clients is unchanged
            result["words"] = words
        return result
    except httpx.HTTPError as error:
        raise HTTPException(502, "dictation_failed") from error
