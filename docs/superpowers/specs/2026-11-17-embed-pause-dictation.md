# Embed review: pause = talk, play = silence

Scope: AutoReview embed player (`?embed=1`, Telegram webview). Code: `apps/web/lib/embed-dictation.ts` (state machine),
`apps/web/components/review/flow-view.tsx` (embed branch). Reuses the existing dictation path unchanged:
`startMicRecording` -> `dictate` (guestDictate) -> `notesFromDictation` (per-sentence times via `rec-timeline`).

## Why
The video's own audio must never land in the transcript, and Alan should not have to start/stop a recording by hand.
So the mic runs only while the video is paused.

## Behaviour

| Event | Video | Mic | Saved |
|---|---|---|---|
| Page opens | paused | off (no permission prompt) | nothing |
| First Play | playing | off | nothing |
| Pause (bar, tap on video, Space, ended) | paused | starts | nothing yet |
| Comment while playing | pauses | starts, comment box focused (fine pointer or typing mode only) | nothing yet |
| Draw / tap on video while listening | stays paused | keeps running | marks go with the sentence spoken then |
| Scrub while paused, keep talking | paused at new time | keeps running | later sentences get the new playhead |
| Play again | playing | closes segment, off | one note per sentence + its ink; segment under 0.7 s with no ink = no note |
| Comment while listening ("Stop") | paused | closes, stays off until next Play | notes as above |
| Cancel | unchanged | discards | nothing; stays off until next Play |
| Type + send | not dictating | unchanged | typed note at current playhead |

While the mic is on, the column is one row only: Cancel (left), red dot + timer, Stop (right). No typing field, no status line; the video gets the freed height. The typing field returns when not dictating (stopped, typing mode).

## Errors
- Bei Mikrofon verweigert / nicht unterstuetzt (Telegram-Webview) -> Tipp-Modus fuer die Sitzung: ein Hinweis "Microphone not available. Type your note below.", Kommentarfeld fokussiert, kein erneuter Mic-Versuch.
- Bei Play waehrend das Mic noch oeffnet -> Aufnahme sofort verworfen, kein Zustand haengt.
- Bei Transkription fehlgeschlagen -> bestehendes "Try again" (Audio bleibt erhalten).
- Bei Zeichnen im Tipp-Modus (kein Mic) -> Striche warten und werden bei Play, getippter Notiz oder Send als Notiz am Playhead gespeichert (Text = getippt, sonst "Drawing"). Nie verloren.

## Not changed
Non-embed views, backend, dictation endpoint, outbox, ink format.

## Done when
- State machine unit-tested (play/pause/comment/stop/denied, scrub timestamps).
- FlowView embed tests: pause starts mic, play flushes and saves, silent pause saves nothing, denied -> typing, typed note works.
- Full web test suite and `next build` green; screenshots at 390x844 and 1280.

## Type instead (addendum)

While dictating, the one row is Cancel, timer, Type, Stop. Type (keyboard icon, "Type a note instead") flushes what was said into its note and opens the typing field focused (also on phones) at the current playhead; ink keeps working. Typing lasts until the next Play, which saves the typed note and plays; the next pause dictates again. A denied mic stays in typing mode (sticky). State machine: event `type`, flag `typeOnce`.
