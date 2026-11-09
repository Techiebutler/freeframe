# Dictation v2 report, 2026-11-09

Spec: docs/superpowers/specs/2026-11-09-review-dictation-v2.md

## Root causes
- Half sentences / dropouts: browser audio defaults (echo cancel, noise suppression, AGC) while the video plays. apps/web/lib/recorder.ts:15. Inferred from code, not reproduced with Alan's audio.
- Wrong words / language flips: no `language`, no `prompt`. apps/api/services/dictation.py:21.
- Lost audio on hiccup: no timeslice. recorder.ts:18. No client length cap exists, so no "cut-off" in code.
- Split sentences: one note per Whisper segment. apps/web/lib/flow-notes.ts:77-79.
- Wrong video time: timeline clock started after mic setup (flow-view.tsx startedAt after `await start()`), time taken from segment start not first word, no `playing`/`waiting` events (rec-timeline.ts:20).

## Tests
- Web (vitest): 973 passed -> 984 passed (+11 new in lib/__tests__/dictation-sentences.test.ts); `tsc --noEmit` clean.
- API: baseline NOT run. No Python deps installed here (pip install was denied in this session). Added 3 tests in apps/api/tests/test_agent_mobile.py; the service logic was checked with a stubbed httpx/fastapi script (prompt 799 chars, language de/en/auto, bad_lang 400, granularities). CI must confirm the API suite.

## Decisions
- No cleanup pass: FreeFrame only has `groq_api_key`, no LLM client.
- `words` is omitted from responses when empty, so existing exact-shape tests and v1 clients keep passing.
- Language default de on the server; no UI switch (client can send `lang`).
- Sentence + same-frame merge (0.5 s video time) kept: paused video still yields one note per frame.
- No roll-over segments: there is no max recording length to roll over.
