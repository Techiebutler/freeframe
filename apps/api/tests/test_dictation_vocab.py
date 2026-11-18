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


def _whisper(segments, text=None, status=200):
    w = MagicMock(status_code=status)
    w.json.return_value = {"text": text if text is not None else " ".join(s["text"] for s in segments), "segments": segments}
    return w


def _seg(text, start=0.0, end=1.0, **extra):
    return {"start": start, "end": end, "text": text, **extra}


def test_hallucinated_segments_are_dropped_and_valid_ones_survive(monkeypatch):
    monkeypatch.setattr(dictation.settings, "groq_api_key", "gsk_test")
    monkeypatch.setattr(dictation, "fix_terms", lambda t: t)
    segs = [_seg("Der Hook ist zu langsam."), _seg(" Sous-titrage ST' 501", 1, 2), _seg("www.zeoranger.de", 2, 3), _seg("Ss.", 3, 4),
            _seg("Untertitel im Auftrag des ZDF, 2017", 4, 5), _seg("Schneller.", 5, 6)]
    with patch("apps.api.services.dictation.httpx.post", return_value=_whisper(segs)):
        out = dictation.transcribe(b"1", "a.webm", "audio/webm")
    assert [s["text"] for s in out["segments"]] == ["Der Hook ist zu langsam.", "Schneller."]
    assert out["text"] == "Der Hook ist zu langsam. Schneller."


def test_only_hallucinations_give_empty_text(monkeypatch):
    monkeypatch.setattr(dictation.settings, "groq_api_key", "gsk_test")
    with patch("apps.api.services.dictation.httpx.post", return_value=_whisper([_seg("Sous-titrage ST' 501")])), \
         patch("apps.api.services.dictation.httpx.request") as req:
        out = dictation.transcribe(b"1", "a.webm", "audio/webm")
    assert out["text"] == "" and out["segments"] == []
    req.assert_not_called()


def test_silence_probabilities_drop_a_segment_only_when_both_are_bad(monkeypatch):
    monkeypatch.setattr(dictation.settings, "groq_api_key", "gsk_test")
    monkeypatch.setattr(dictation, "fix_terms", lambda t: t)
    segs = [_seg("Ghost words here", no_speech_prob=0.9, avg_logprob=-1.4), _seg("Quiet but real", 1, 2, no_speech_prob=0.9, avg_logprob=-0.3),
            _seg("Clear but odd", 2, 3, no_speech_prob=0.1, avg_logprob=-1.5)]
    with patch("apps.api.services.dictation.httpx.post", return_value=_whisper(segs)):
        out = dictation.transcribe(b"1", "a.webm", "audio/webm")
    assert [s["text"] for s in out["segments"]] == ["Quiet but real", "Clear but odd"]


def test_fixup_still_maps_onto_segments_after_the_filter(monkeypatch):
    monkeypatch.setattr(dictation.settings, "groq_api_key", "gsk_test")
    segs = [_seg("Amara.org"), _seg("Chatsuki ist gut", 1, 2)]
    with patch("apps.api.services.dictation.httpx.post", return_value=_whisper(segs, text="Amara.org Chatsuki ist gut")), \
         patch("apps.api.services.dictation.httpx.request", return_value=_chat("ChatGPT ist gut")):
        out = dictation.transcribe(b"1", "a.webm", "audio/webm")
    assert out["text"] == "ChatGPT ist gut" and out["segments"][0]["text"] == "ChatGPT ist gut"
