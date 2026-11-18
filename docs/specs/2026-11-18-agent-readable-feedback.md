# Agent-readable feedback (spec, no code)

Status: draft for founder review, 2026-11-18. Repos: `videoaditor/freeframe` (this repo) and `videoaditor/feedback-agent`. Paths below are relative to the repo named; `ff:` = freeframe, `fa:` = feedback-agent (read at origin/main).

## Goal

An agent that reads a `feedback.v1` round understands the reviewer as well as a human who sat next to them:

1. Every comment with a drawing carries a PNG: the video frame at the mark's time, strokes burned in, from the exact version the reviewer saw.
2. Dictation word timestamps ride in the same clock as `marks[]`, and each comment lists `segments: [{text, mark_ids, video_t}]` so "here" maps to the stroke drawn at that moment.
3. One spoken dictation is recognisable as one unit even when it became several comments (no orphan fragments such as the BOF CTA "as likeable as possible").
4. The dictation's raw audio is an attachment so an agent can re-transcribe with brand vocabulary.

All changes are additive to `feedback.v1`; no existing field is renamed or removed.

## Today

**Capture (web).**
- Marks are recorded with `{k, points, times, t: playhead, offset_ms: Date.now() - active.startedAt}`: `ff:apps/web/components/review/flow-view.tsx:520` (typed/embed: `offset_ms: 0`, line 521). Shape: `ff:apps/web/lib/ink.ts:6-16` (`t` = video seconds, `offset_ms` = ms since the recording started, `times[i]` = ms since the stroke began, per point; points are 0..1 of the picture).
- Saved as `drawing_data = {format:"ink.v1", mark_offset_ms: marks[0].offset_ms, marks:[...]}`: `ff:apps/web/lib/ink.ts:32-39`. Marks carry no id.
- The recording is sent to `/dictate` (`ff:apps/web/lib/agents.ts:104-109`) which returns `{text, segments, words?}`. After `notesFromDictation` the audio blob, the words and the segment timings are dropped (`ff:apps/web/components/review/flow-view.tsx:43`, reducer `done` sets `audio: undefined`; `:289-299` transcribe). Nothing about the dictation is persisted except each note's text.
- Dictation to notes (H69): `ff:apps/web/lib/flow-notes.ts:86-106`. One note per sentence (`sentencesFromDictation`, `ff:apps/web/lib/dictation-sentences.ts:53-69`: ends at `. ? !` or a pause over `PAUSE_S = 1.5`, `:10`), each stamped `timeAt(sentence.start*1000)` (`flow-notes.ts:93`), a mark joins the last sentence that had started at its `offset_ms` (`:94-98`), noise parts dropped by `isNoiseText` (`:73-77`, applied `:89`), neighbours closer than `SAME_FRAME_S = 0.5` s of video time merged (`:99-109`). `timeAt` maps recording offset to video time including pauses and seeks (`flow-view.tsx:297`).
- Embed state machine (play closes a segment, pause starts one, `MIN_SEGMENT_MS = 700`): `ff:apps/web/lib/embed-dictation.ts:20-51`. Each pause/play cycle is its own recording, so one reviewer "thought" spanning a seek is already several recordings.

**Server.**
- `ff:apps/api/services/dictation.py:73-109`: Groq whisper-large-v3-turbo, `timestamp_granularities: word + segment`; returns `{text, segments:[{start,end,text}], words:[{start,end,word}], raw_text?}`. Times are seconds since the recording start. `apply_fixes` (`:56-70`) patches segment text but not `words`. Nothing is stored.
- Models: `ff:apps/api/models/comment.py:17-41` (`Comment`: `version_id`, `timecode_start/end`, `body`, `attachments_expected`), `:43-49` (`Annotation.drawing_data` JSONB), `:51-61` (`CommentAttachment`: `file_type` = content type, `s3_key`, `original_filename`, `uploaded_at`; no `kind` column). Allowed upload types are images only (`ff:apps/api/services/comment_attachments.py:11`).
- Drawn frame already exists client-side: `ff:apps/web/lib/drawn-frame.ts` renders video frame + ink to `drawn-frame.jpg` (canvas, max side 1280, JPEG 0.85, `:7-8`), uploaded after the comment (`ff:apps/web/lib/note-outbox.ts:26-33, 52, 68`). Weak points: it is documented as "a nicety" that silently falls back to no picture (`drawn-frame.ts:1-3`); a cross-origin video taints the canvas (`:22-35`); the shot is looked up only for the first mark's time with 0.25 s tolerance and all marks of the note are drawn on it (`flow-view.tsx:283`, `drawn-frame.ts:38-43`), so a note whose marks sit on different frames gets a wrong picture; ink is white, not the red the agents' tooling expects.
- Feedback builder: `ff:apps/api/services/feedback_rounds.py:189-213` (`feedback_v1`). The comment object is `{comment_id, t_start, t_end, text, drawing:{drawing_data, frame_url, mark_offset_ms}, attachments:[{attachment_id, file_name, content_type, url}], author, author_kind}`. The drawn frame is hidden from `attachments` (`:167-169, 207`) and surfaced only as `drawing.frame_url`; without it `_frame_url` falls back to the version thumbnail (`:171-186`), which is the wrong frame. Served by `GET /agent/feedback`: `ff:apps/api/routers/agent.py:95-110`. A round is held back while a comment's expected images are missing: `feedback_rounds.py:153-156`.
- Media: `MediaFile` has `s3_key_raw`, `s3_key_processed` (HLS), `s3_key_thumbnail`, `width/height/fps` (`ff:apps/api/models/asset.py:75-91`); `ff:apps/api/tasks/transcode_tasks.py` already runs ffmpeg (`Dockerfile`/`Dockerfile.prod` install it) on a Celery worker (`ff:apps/api/tasks/celery_app.py:16-25`).

**Agent side (feedback-agent).**
- `fa:src/mcp.ts:238-256` `flatFeedback` flattens `files[].comments[]` into `comments[]` with `{...c, asset_id, version_id, file_name, version_number}`; unknown comment fields pass through, so additive fields survive.
- `fa:docs/agent-playbook.md:42` (and `fa:src/agent-playbook.ts`): "Known gap: `frame_url` is currently the asset's thumbnail ... Take the frame from the video itself at `t_start` and lay the shapes over it." That is the contract this spec retires. Note it also says `t_start`, but the drawn frame time is `drawing_data.marks[].t`, which can differ from `t_start` (the BOF case).
- Local workaround: `ar_drawings.py` (scratchpad) takes `marks[0].t`, ffmpeg-extracts the frame from a local master matched by file name, draws `m.points * (W,H)` as 8 px red lines. Same stroke format as `ink.v1`. It needs the master on disk and matches versions by file name, which is why it cannot be trusted for the exact version.
- Observed failure (BOF CTA): words "as likeable as possible" at 7.7 s belong to the comment at 12.4 s whose drawing sits at 7.67 s. Cause not reproduced here (no tests run). Plausible: the sentence was split by `PAUSE_S`/punctuation, the fragment got `timeAt(7.7)` while the sentence containing the marks was stamped from a later `timeAt` after a seek, and the two are more than `SAME_FRAME_S` apart so they never merge (`flow-notes.ts:99-105`). Task T6 reproduces it with a fixture first.

## Contract (additive to feedback.v1)

Per comment, three new things, plus one new per-round list.

```json
{
  "comment_id": "...",
  "t_start": 12.4,
  "text": "...",
  "dictation_id": "d3b1...",            // null for typed notes
  "segment_index": 1,                    // this comment's segment within the dictation; null for typed
  "drawing": {
    "drawing_data": { "format": "ink.v1", "marks": [ { "mark_id": "m0", "t": 7.67, "offset_ms": 6900, "times": [0, 16, 33], "k": "stroke", "points": [[0.1, 0.2]] } ] },
    "frame_url": "<url of the first frame_png, kept for old agents>",
    "mark_offset_ms": 6900
  },
  "attachments": [
    { "attachment_id": "...", "kind": "frame_png", "url": "...", "content_type": "image/png",
      "file_name": "frame-7.670.png", "version_id": "<comment.version_id>", "t": 7.67, "mark_ids": ["m0", "m1"],
      "width": 1080, "height": 1920 },
    { "attachment_id": "...", "kind": "dictation_audio", "url": "...", "content_type": "audio/webm",
      "file_name": "dictation.webm", "version_id": "<comment.version_id>", "t": null, "duration_s": 14.2 },
    { "attachment_id": "...", "kind": "reference_image", "url": "...", "content_type": "image/png", "file_name": "...", "version_id": "...", "t": null }
  ],
  "segments": [
    { "text": "make this as likeable as possible", "start_s": 6.1, "end_s": 9.0, "video_t": 7.7, "mark_ids": ["m0"] }
  ]
}
```

Per round, next to `files`:

```json
"dictations": [
  { "dictation_id": "d3b1...", "comment_ids": ["...", "..."], "text": "<full text, fixed>", "raw_text": "<whisper raw, if different>",
    "lang": "de", "audio_attachment_id": "...", "clock": "recording_s",
    "words": [ { "w": "as", "start_s": 6.10, "end_s": 6.24 } ],
    "segments": [ { "text": "...", "start_s": 6.1, "end_s": 9.0, "video_t": 7.7, "mark_ids": ["m0"], "comment_id": "..." } ] }
]
```

Rules:
- `kind` is one of `frame_png | dictation_audio | reference_image`. Existing agents that only read `attachments[].url` keep working; they now also see the PNG and the audio, which is wanted. The old filename trick (`drawn-frame*`, `feedback_rounds.py:167-169`) is replaced by the `kind` column (T1).
- One `frame_png` per distinct frame: marks whose `t` are within `INK_FRAME_TOL` (0.25 s, `ink.ts`) share one PNG; `t` is the frame time (a mark's `t`, never `t_start`), `mark_ids` lists the strokes burned in. A comment with marks on two frames has two PNGs.
- `mark_id` = `"m" + index` in `drawing_data.marks`, derived server-side (no client change needed, stable because `marks` is stored once).
- Clock: all dictation times are seconds since the recording start (`start_s`, `end_s`; same unit as Whisper). A mark's stroke start is `marks[].offset_ms / 1000` on that same clock, and point i was drawn at `(offset_ms + times[i]) / 1000`. So "here" at word time `w.start_s` maps to the stroke whose interval `[offset_ms, offset_ms + times.last]` contains it, or is nearest to it. `video_t` is the video time of the segment start (`timeAt(start_s*1000)`), the same clock as `marks[].t` and `t_start`. For typed notes `offset_ms` is 0 and there is no `dictation_id`.
- `segments[].mark_ids` come from `marks` whose `offset_ms` falls inside `[start_s*1000, next.start_s*1000)` (same assignment rule as `flow-notes.ts:94-98`, made explicit).
- `dictations[]` is the authoritative grouping; comment-level `segments` are the comment's own slice (option (a) below).
- `drawing.frame_url` stays and points at the first `frame_png` (fallback: today's client JPEG, then the thumbnail, as now).

## Option analysis for item 3 (one dictation = one comment)

H69 (dictation v2: one note per spoken sentence, stamped at the video time it was said; `flow-notes.ts:81-86`) exists because each note must land on the scene it talks about, drive `t_start` ordering, and give rule candidates a `scene` scope (`feedback_rounds.py:55-60`). Item 3 wants the opposite granularity. Options:

**(a) Keep the split, link fragments.** Notes stay one per sentence. Add `dictation_id` + `segment_index` on each comment and the round-level `dictations[]` with every segment, its `comment_id`, `video_t` and `mark_ids`. Tighten fragment merging: a fragment without terminal `. ? !` that was cut only by `PAUSE_S` and whose marks or words overlap a sibling's marks joins that sibling. Pros: no change to H69 behaviour or to the human review UI, comments still sort by scene, additive to the contract, reversible. Cons: an agent has to read `dictations[]` to see the whole thought (the playbook tells it to).

**(b) One comment per dictation.** One comment, `t_start` = first segment's `video_t`, `text` = full dictation, `segments[]` each with their own `video_t`, `mark_ids`. Pros: matches how the reviewer thinks, nothing can be orphaned. Cons: breaks H69 and the "one comment = one fixable note" unit the human UI, the resolve/approve flow, the rule-candidate scoping and `t_start` ordering rely on; a dictation that spans a seek (embed mode closes a recording at every Play) would put its comment on one scene while instructions refer to several; a comment can no longer be resolved piecemeal; existing agents that handle one instruction per comment degrade. Larger change in `flow-notes.ts`, `note-outbox.ts`, the comment POST, and rounds.

**Recommendation: (a).** It fixes the observed failure (agents see the fragment and the drawn comment as one dictation) without redefining the comment. Revisit (b) only if agents still mis-handle linked comments after a measured trial (see Open decisions).

## Where the PNG is rendered

**Option 1, client canvas export at save time** (exists: `drawn-frame.ts`). Pros: it is literally what the reviewer's player showed. Cons: silent failure modes (tainted canvas, no shot taken, `nearestShot` miss, marks on several frames) mean "every drawing gets a PNG" cannot be promised; JPEG not PNG; only first mark's frame; depends on a second upload that can fail after the comment exists (`note-outbox.ts:26-33`); guests on share links hit it hardest.

**Option 2, server-side worker: ffmpeg frame extract + stroke burn-in. Recommended.** After a comment with an `Annotation` is saved, enqueue a Celery task (`ff:apps/api/tasks/`, new `drawn_frame_tasks.py`, registered in `celery_app.py:16-25`) that, per distinct mark frame: picks the source for `comment.version_id` (`MediaFile.version_id == comment.version_id`: `s3_key_raw` if present, else the review proxy/HLS from `s3_key_processed`), extracts one frame at the mark's `t` with ffmpeg (`-ss <t> -i <src> -frames:v 1`, frame-accurate for single-frame decode), burns in the strokes with the exact look of `drawMarks` (`drawn-frame.ts:48-69`, ported to Pillow; Pillow must be in `requirements.txt`, T3 verifies) and stores `frame-<t>.png` as a `CommentAttachment(kind="frame_png")`. Pros: runs for every drawing regardless of browser, CORS or network; no extra upload from the reviewer's phone; one code path agents can rely on; re-runnable (backfill for old rounds). Cons: ffmpeg time on the worker; a proxy source may differ in resolution from what the reviewer saw (same frame, lower resolution; raw preferred).

**Exact-version guarantee.** The render keys on `comment.version_id`, which the client sends with the comment from the player's current version (`note-outbox.ts:42` `version_id: p.versionId`; share path `folder-share-viewer.tsx:853`), never on "latest version of the asset" and never on file name (the failure of `ar_drawings.py`). Versions are immutable media rows (a new upload is a new `AssetVersion`); `upgrade_video_renditions` swaps renditions of the same version, not content. The PNG carries `version_id` in the contract so an agent can assert `attachment.version_id == file.version_id`. Residual risk: the client sending a stale `versionId` while the player shows another; T2 adds a test that the version on the comment equals the version of the playing source, and the client export (option 1) is kept as a fallback only when the worker fails, labelled `frame_png_source: "client"` in the attachment.

**Readiness.** A round must not close before the PNGs exist: reuse the hold-back that exists for images (`feedback_rounds.py:153-156`): a drawn comment counts as pending until its `frame_png` is uploaded or the render task failed/timed out (60 s), then proceeds with `drawing.frame_url` fallback and `frame_status: "failed"`.

## Storage, retention, cost

Numbers are estimates until T8 measures them.
- PNG: 9:16, max side 1280 (same cap as `drawn-frame.ts:7`) is about 0.5-1.5 MB each. One per distinct mark frame, typically 1-2 per drawn comment.
- Audio: webm/opus as recorded, about 0.1-0.2 MB per 10 s (cap: `dictation.MAX_BYTES` 25 MB, `dictation.py:19`).
- Both go in the existing comment-attachment bucket/prefix via `s3_service`, presigned for 7 days like today (`feedback_rounds.py:208-209`); agents keep `attachment_id` and ask again for a fresh url (already in the playbook).
- Retention: lives as long as its comment; deleted with the comment (soft delete `deleted_at`, then the existing cleanup task `ff:apps/api/tasks/cleanup_tasks.py`). Audio is personal voice data of reviewers including customers and guests: see Open decision 1.
- Compute: one ffmpeg single-frame decode per distinct frame, about 0.3-1 s on the worker (estimate), no new service. Groq cost unchanged (the audio was already sent once; it is now also stored). Re-transcription by an agent is the agent's own cost.

## Tasks

Each task = one PR-sized lane. `Verified:` commands are run by the implementer (not by the spec author).

- **T1 attachments kind + audio type.** `ff:apps/api/models/comment.py` add `CommentAttachment.kind` (`String(20)`, default `reference_image`), `version_id` (nullable), `t` (Float nullable), `meta` (JSONB nullable: mark_ids, size, duration); Alembic migration in `ff:apps/api/alembic/versions/`; allow `audio/webm`, `audio/mp4`, `audio/ogg` in `ff:apps/api/services/comment_attachments.py:11` with a separate size cap; replace the `drawn-frame*` name test in `feedback_rounds.py:167-169` with `kind == "frame_png"` (keep the name test as legacy fallback). Verified: `cd /Users/alansimon/freeframe-wt-agentread && python -m pytest apps/api/tests/test_feedback_rounds.py -q -k "attachment or drawn"`
- **T2 persist the dictation.** New table `comment_dictations` (`id`, `version_id`, `text`, `raw_text`, `lang`, `words` JSONB, `segments` JSONB, `audio_attachment_id`, `created_at`) and `Comment.dictation_id`, `Comment.segment_index`; extend the comment POST and the guest share POST to accept `dictation` (id generated client-side so the split notes share it; idempotent on `Idempotency-Key`); `ff:apps/web/lib/flow-notes.ts` (`notesFromDictation` returns `dictation_id`, `segment_index`, per-part `start_s`, `end_s`, `mark_ids`), `ff:apps/web/components/review/flow-view.tsx:289-299` keeps `words`/`audio` instead of discarding them, `ff:apps/web/lib/note-outbox.ts` sends them and uploads the audio as `dictation_audio`; fix `apply_fixes` (`dictation.py:56-70`) to patch `words` too. Include the test that `comment.version_id` equals the playing version. Verified: `cd /Users/alansimon/freeframe-wt-agentread/apps/web && npx vitest run lib/__tests__/flow-notes.test.ts components/review/__tests__/flow-view.test.tsx` and `python -m pytest apps/api/tests/test_dictation_vocab.py apps/api/tests/test_feedback_rounds.py -q`
- **T3 server-side render worker.** `ff:apps/api/tasks/drawn_frame_tasks.py` + register in `celery_app.py`; helper `ff:apps/api/services/drawn_frame.py` (cluster marks by `INK_FRAME_TOL`, ffmpeg extract, Pillow burn-in ported from `drawn-frame.ts:48-69`, upload as `frame_png` with `version_id`, `t`, `meta.mark_ids`); enqueue from the comment-create path when an `Annotation` exists; hold the round until rendered or failed (`feedback_rounds.py:153-156`); `scripts/` backfill for comments without a PNG. Verified: `python -m pytest apps/api/tests/test_drawn_frame.py -q` (pure parts: clustering, stroke pixels on a synthetic 100x100 frame, source choice by `version_id`).
- **T4 feedback.v1 builder.** `ff:apps/api/services/feedback_rounds.py:189-213`: `attachments[]` with `kind`, `version_id`, `t`, `mark_ids`, `width`, `height`, `duration_s`; `mark_id` on marks; comment `dictation_id`, `segment_index`, `segments`; round `dictations[]`; `drawing.frame_url` = first `frame_png`; extend `build_feedback_v1` snapshot and `rule_candidates` untouched. Verified: `python -m pytest apps/api/tests/test_feedback_rounds.py -q` (snapshot updated, old keys all still present).
- **T5 mark-to-word mapping is a pure function with a golden test.** One function (`segments_for(words, marks)`) used by the builder for backfill and by tests; golden fixture is the BOF CTA case (words at 7.7 s, mark at 7.67 s, comment at 12.4 s). Verified: `python -m pytest apps/api/tests/test_feedback_rounds.py -q -k segments`
- **T6 reproduce and fix the BOF split.** Write the failing fixture first in `ff:apps/web/lib/__tests__/flow-notes.test.ts` (Whisper words/segments for the BOF case, `timeAt` with a seek), then implement the (a) merge rule in `flow-notes.ts:99-109`: a pause-only fragment (no terminal `. ? !`) joins the sibling whose marks or time it overlaps; keep `SAME_FRAME_S`. Verified: `cd /Users/alansimon/freeframe-wt-agentread/apps/web && npx vitest run lib/__tests__/flow-notes.test.ts`
- **T7 feedback-agent contract.** `fa:src/mcp.ts:238-256` `flatFeedback`: pass `dictations`, `segments`, `attachments[].kind` through unchanged (add a test with the new fields; sort stays by `t_start`); `fa:docs/agent-playbook.md:42` and `fa:src/agent-playbook.ts`: replace the "Known gap" text with: use `attachments[kind=frame_png]` (burned-in strokes, exact version), read `segments`/`dictations` to map "here" to a stroke, one dictation = the `dictation_id` group, re-transcribe from `kind=dictation_audio` when a name looks wrong; bump the playbook version line; the gen `ar_get_feedback` tool needs the same pass-through check. Verified: `cd /Users/alansimon/Desktop/feedback-agent && npx vitest run test/mcp-feedback-flat.test.ts test/agent-playbook.test.ts`
- **T8 measure on the real thing.** After deploy, pull one live round with a drawing and one dictation via `/agent/feedback`, check the Done block, record PNG size and render time in the PR. Verified: `curl -s -H "Authorization: Bearer $AGENT_KEY" https://<ff-host>/agent/feedback | python3 -c "import sys,json;r=json.load(sys.stdin)['rounds'][0];print([a['kind'] for f in r['files'] for c in f['comments'] for a in c['attachments']], len(r.get('dictations',[])))"` (key from Keychain `aditor-autoreview-agent`; never print it).

Order: T1 -> T2 and T3 in parallel -> T4 -> T5/T6 -> T7 -> T8. Local runs are single-file (Mac load): never the full suites.

## Done (machine-checkable)

All must hold on a live round that has one drawn comment and one multi-sentence dictation:
1. Every comment with `drawing != null` has at least one `attachments[]` entry with `kind == "frame_png"`, `content_type == "image/png"`, `version_id == files[].version_id`, and `t` equal to one of its `drawing_data.marks[].t` (within 0.25 s).
2. Fetching that PNG returns HTTP 200 and non-zero bytes; stroke pixels are present (the PNG differs from a plain frame extract at the same `t`: pixel diff > 0 in the stroke region).
3. Every comment from a spoken dictation has `dictation_id`, `segment_index`, non-empty `segments[]` with `video_t` and `mark_ids` referencing existing `mark_id`s; the round has a `dictations[]` entry listing all those `comment_ids`.
4. `dictations[].words[].start_s` are monotonic and `<=` the audio `duration_s`.
5. Every dictation has an `attachments` entry `kind == "dictation_audio"` that downloads and has `duration_s > 0`.
6. The BOF fixture yields one `dictation_id` shared by the 7.7 s fragment and the 12.4 s comment, and the 7.67 s mark appears in a segment's `mark_ids`.
7. Old fields unchanged: `python -m pytest apps/api/tests/test_feedback_rounds.py -q` and `npx vitest run test/mcp-feedback-flat.test.ts` (feedback-agent) pass.

## Stop and escalate

Stop and ask the founder/lead if: the raw master for a version is not retained and only a transcode exists (resolution differs from what the reviewer saw; say so in the attachment `meta`, do not silently substitute another version); a drawn comment's `version_id` cannot be proven equal to the playing version; the worker needs a new service or paid dependency; audio storage conflicts with a customer's data terms; option (b) turns out to be required; any change would alter existing `feedback.v1` keys; ffmpeg render time on the worker exceeds 5 s per frame at p95.

## Open decisions for the founder (max 3)

1. **One comment per dictation, or linked?** Recommendation: (a) keep one note per sentence and link them with `dictation_id` + `dictations[]` (agents see one thought; humans keep scene-accurate notes). Choose (b) only if linked comments still confuse agents in the T8 trial.
2. **Store dictation audio for guests and customers, and for how long?** Recommendation: yes, store it (agents need it to re-transcribe); keep it as long as the comment, one line under the mic button ("your voice note is kept with this comment"), and delete audio 90 days after the round is acknowledged.
3. **PNG source of truth.** Recommendation: server-side render for every drawing (guaranteed, exact version); keep the client JPEG only as a labelled fallback. The cost is a small ffmpeg job per drawing on the existing worker; no new service.
