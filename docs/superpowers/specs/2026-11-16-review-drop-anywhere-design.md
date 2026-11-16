# Review: drop an image anywhere — design

Status: spec for Alan's go · Size: S · Alan 2026-11-16 ("haben wir schon cleanen drag and drop für das kommentar feld" → "spec")

## Why

Today an image only attaches when it is dropped on the thin strip around the comment bar (desktop review, `flow-view.tsx` wide layout). Dropped on the video or the notes column, the browser opens the image in the tab and the reviewer leaves the review. Nothing shows where to drop while dragging.

## What

1. **The whole review is the drop target** (desktop layout only; on a phone there is no drag and drop, Alan 2026-11-17): files bar, video, comment bar, notes column.
2. **While a file is dragged over it**: the video pauses, and one overlay covers the review. It has a dashed outline and one line in the middle: "Drop to attach to a comment at 0:12". The time is the playhead.
3. **On drop**: the images go into the same tray as paste / paperclip today (`addImages`, same rules: PNG/JPEG/WebP/GIF, ≤ 10 MB, max 4, same skip message). Focus moves to the comment input, so the next words or Comment press carry them. Nothing is sent by the drop alone.
4. **Never navigates away**: a file dropped anywhere on the page (also outside the review, also a non-image) is caught. A non-image shows the existing "Only PNG, JPEG, WebP or GIF images up to 10 MB." line instead of opening the file.
5. **View-only shares** (`canComment` false): no overlay, drop is swallowed silently.
6. The overlay leaves on drop, on drag leaving the window, and on Esc.

## Not in scope

Dropping videos or PDFs as attachments, multi-page drop zones in the folder grid, a drop zone in Classic comments.

## Scope

- `apps/web/components/review/flow-view.tsx`: drag state on the root (count dragenter/dragleave so child elements don't flicker), overlay, window-level `dragover`/`drop` guard that only `preventDefault`s.
- `apps/web/components/review/__tests__/flow-view.test.tsx`.

## Done

- Vitest: dragenter on the video shows the overlay with the playhead time and calls `onPause`; drop of a PNG on the video puts it in the tray; drop of a `.pdf` shows the skip line and adds nothing; `canComment=false` shows no overlay; a drop on `window` calls `preventDefault`.
- `pnpm test` in `apps/web` green, typecheck clean for the touched files.
- Screenshot of the overlay at 1440, opened for Alan before merge.

## Stop & escalate

- If catching drops on `window` breaks dropping files in another FreeFrame screen (upload in the dashboard) → limit the guard to the share/review routes and say so.

## Doctrine gate

- [x] Seen by Alan live (2026-11-16 share review).
- [x] One input path: the drop feeds the existing image tray, no new upload code.
- [x] Reversible, frontend only, no server or data change.
- [x] Preserves work: never navigates away from unsaved notes (Postel's / UX law 15).
