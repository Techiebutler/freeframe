"""Dictation vocabulary: terms in the Whisper prompt and the cheap fix-up pass (skipped without a key, never worse than the raw text)."""
from unittest.mock import MagicMock, patch

from apps.api.services import dictation


def _chat(content, status=200):
    r = MagicMock(status_code=status)
    r.json.return_value = {"choices": [{"message": {"content": content}}]}
    return r


def test_prompt_carries_tool_and_ad_terms():
    prompt = dictation.build_prompt()
    assert len(prompt) <= dictation.MAX_PROMPT
    for term in ("Claude", "ChatGPT", "Foreplay", "Genmoji", "Ryze", "Footage", "Whoosh"):
        assert term in prompt


def test_fixup_is_skipped_without_a_key(monkeypatch):
    monkeypatch.setattr(dictation.settings, "groq_api_key", None)
    with patch("apps.api.services.dictation.httpx.request") as req:
        assert dictation.fix_terms("Chatsuki ist gut") == "Chatsuki ist gut"
    req.assert_not_called()


def test_fixup_repairs_a_misheard_term_and_sends_the_vocabulary(monkeypatch):
    monkeypatch.setattr(dictation.settings, "groq_api_key", "gsk_test")
    with patch("apps.api.services.dictation.httpx.request", return_value=_chat("ChatGPT ist gut")) as req:
        assert dictation.fix_terms("Chatsuki ist gut") == "ChatGPT ist gut"
    assert "Foreplay" in req.call_args.kwargs["json"]["messages"][0]["content"]


def test_fixup_ignores_a_rephrase_a_failure_and_garbage(monkeypatch):
    monkeypatch.setattr(dictation.settings, "groq_api_key", "gsk_test")
    for reply in (_chat("Sure! Here is a much longer answer that rephrases everything you said in the note."), _chat("x", 500), MagicMock(status_code=200, json=MagicMock(return_value={}))):
        with patch("apps.api.services.dictation.httpx.request", return_value=reply):
            assert dictation.fix_terms("Chatsuki ist gut") == "Chatsuki ist gut"


def test_transcribe_returns_fixed_text_and_keeps_the_raw(monkeypatch):
    monkeypatch.setattr(dictation.settings, "groq_api_key", "gsk_test")
    whisper = MagicMock(status_code=200)
    whisper.json.return_value = {"text": " Chatsuki ist gut", "segments": []}
    with patch("apps.api.services.dictation.httpx.post", return_value=whisper) as post, \
         patch("apps.api.services.dictation.httpx.request", return_value=_chat("ChatGPT ist gut")):
        out = dictation.transcribe(b"1", "a.webm", "audio/webm")
    assert out["text"] == "ChatGPT ist gut" and out["raw_text"] == "Chatsuki ist gut"
    assert "ChatGPT" in post.call_args.kwargs["data"]["prompt"]


def test_fix_reaches_the_segments_and_timings_stay(monkeypatch):
    monkeypatch.setattr(dictation.settings, "groq_api_key", "gsk_test")
    whisper = MagicMock(status_code=200)
    whisper.json.return_value = {"text": " Chatsuki ist gut. Der Rice Mushroom Hook sitzt.", "segments": [
        {"start": 0.0, "end": 1.5, "text": " Chatsuki ist gut."}, {"start": 1.5, "end": 3.0, "text": " Der Rice Mushroom Hook sitzt."}]}
    with patch("apps.api.services.dictation.httpx.post", return_value=whisper), \
         patch("apps.api.services.dictation.httpx.request", return_value=_chat("ChatGPT ist gut. Der Ryze Hook sitzt.")):
        out = dictation.transcribe(b"1", "a.webm", "audio/webm")
    assert out["segments"] == [{"start": 0.0, "end": 1.5, "text": "ChatGPT ist gut."}, {"start": 1.5, "end": 3.0, "text": "Der Ryze Hook sitzt."}]


def test_a_replacement_spanning_two_segments_is_skipped():
    segs = [{"start": 0, "end": 1, "text": "Rice"}, {"start": 1, "end": 2, "text": "Mushroom ist gut"}]
    assert dictation.apply_fixes("Rice Mushroom ist gut", "Ryze ist gut", segs) == segs


def test_apply_fixes_patches_the_words_too_and_keeps_their_times():
    words = [{"start": 0.0, "end": 0.4, "word": "Rice"}, {"start": 0.4, "end": 0.9, "word": "Mushroom"}, {"start": 0.9, "end": 1.1, "word": "ist"}, {"start": 1.1, "end": 1.4, "word": "gut"}]
    segs = [{"start": 0.0, "end": 1.4, "text": "Rice Mushroom ist gut"}]
    dictation.apply_fixes("Rice Mushroom ist gut", "Ryze ist gut", segs, words)
    assert [w["word"] for w in words] == ["Ryze", "ist", "gut"] and (words[0]["start"], words[0]["end"]) == (0.0, 0.9)   # two words became one and span both
    words2 = [{"start": 0, "end": 1, "word": "Chatsuki"}, {"start": 1, "end": 2, "word": "gut"}]
    dictation.apply_fixes("Chatsuki gut", "ChatGPT gut", [], words2)
    assert [w["word"] for w in words2] == ["ChatGPT", "gut"]
