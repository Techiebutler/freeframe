# Review dictation v2 (Talk / Comment)

Status: built on `feat/dictation-v2`. Owner: dictation lane. Gen's engine (`gen-aditor` `backend/services/dictation`, spec `2026-11-09-review-input-design.md`) is the reference; this ports what FreeFrame can use without a new provider.

## Problem (Alan, 2026-11-09)

Dictation in the review "Talk" flow transcribes about half a sentence, cuts off, puts notes at the wrong video time, and splits sentences that belong together.

## Diagnosis (code, before this change)

| # | Symptom | Cause | Where |
|---|---|---|---|
| 1 | Half sentences, dropouts | The mic is opened with browser defaults (`audio: true`): echo cancellation, noise suppression and auto gain ON. While the review video plays through the speakers the echo canceller treats speech as echo and gates it; a good external mic gets gated by the suppressor. | `apps/web/lib/recorder.ts:15` |
| 2 | Wrong words, English terms mangled, language flips | Groq call has no `language` (auto-detect on the first seconds) and no `prompt` (no vocabulary: Card, Trello, B-Roll, Hook, brand names). | `apps/api/services/dictation.py:21` |
| 3 | Recording lost on a hiccup | One `MediaRecorder.start()` with no timeslice: nothing exists until `stop()`. There is no length cap in the client, so no "cut-off" is coded; the cut-off Alan hears is cause 1/2, the audio never contained the words. | `recorder.ts:18` |
| 4 | Sentences split | One note per Whisper *segment*. Segments are acoustic chunks (breath, pause, ~30 s window), not sentences. | `apps/web/lib/flow-notes.ts:77-79` |
| 5 | Note lands seconds off | (a) Whisper offsets count from `rec.start()`, the playhead timeline counts from `startedAt = Date.now()` taken after `await start()` (mic + AudioContext setup), so every lookup is shifted by that setup time. (b) Time came from the *segment* start, not the first spoken word. (c) The timeline logs `play` (requested) but not `playing`/`waiting`, so buffering stalls make the model run ahead of the real playhead. | `flow-view.tsx` (`startedAt` after `start()`), `rec-timeline.ts:20` |

## Design

1. **Backend** (`apps/api/services/dictation.py`): `lang` form field (`de` default, `en`, `auto` = no language sent; else 400 `bad_lang`). Whisper `prompt` = hint + terms from `dictation_lexicon.json` (copy of Gen's lexicon), whole terms only, <= 800 chars (Gen's `buildPrompt` rule). `temperature=0`. `timestamp_granularities[]` = `word` + `segment`. Response adds `words: [{start,end,word}]`. No cleanup pass: FreeFrame has no LLM client configured (only `groq_api_key`); not adding a provider.
2. **Recorder**: constraints `{echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1}`, `start(1000)` timeslice so audio is collected continuously, `startedAt` captured at the exact `rec.start()` and exposed.
3. **Sentences** (`apps/web/lib/dictation-sentences.ts`, pure): tokens come from the segment text (carries punctuation), each token is aligned to the word timestamps (forward match, fallback proportional inside its segment). A sentence ends at `. ? !` (not abbreviations like `z.B.`, `bzw.`, ordinals `3.`) or a pause > 1.5 s between tokens. Segments are merged across, never split mid-sentence. Start = first word.
4. **Mapping** (`flow-notes.ts`): per sentence `t = timeAt(first word offset)`. `timeAt` = the recorded timeline (play/pause/seek/rate/buffering); a sentence spanning a seek keeps its first-word time. Ink attaches to the last sentence started when the mark was drawn (unchanged rule). Static review uses the same sentences.
5. Share/guest path sends the same fields (`guestDictate`).

## Error taxonomy

| Code | HTTP | When | UI |
|---|---|---|---|
| `dictation_unavailable` | 503 | no `GROQ_API_KEY` | "Dictation is not set up. Type your note instead." |
| `audio_too_large` | 413 | > 25 MB | generic "Could not transcribe" |
| `bad_lang` | 400 | `lang` not de/en/auto | generic |
| `dictation_failed` | 502 | Groq non-200 / network | "Could not transcribe. Try again or type it." (audio kept, Try again) |
| mic denied / absent | client | `getUserMedia` rejects | "Microphone unavailable. Type your note instead." |
| empty transcript | 200, `text:""` | silence | existing empty-note path |

## Out of scope

Cleanup/filler removal pass (no LLM client), a language switch in the UI, client-side max length (none exists).

## Done

- [ ] `sentencesFromDictation` unit tests: paused video, playing video, seek mid-recording, long sentence over several segments, German with English lexicon words, pause split, abbreviations.
- [ ] API tests: prompt <= 800 chars and whole terms, `language` default de / en / auto, granularities sent, `words` returned, `bad_lang`.
- [ ] Existing web (973) and api tests still green.
- [ ] Manual check on a real German recording with the video playing (needs Alan's mic; not done by the lane).
