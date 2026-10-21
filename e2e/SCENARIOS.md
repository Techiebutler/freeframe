# Upload queue scenario matrix

This is the master matrix for the upload queue work. Every row is one scenario the queue must
handle, with the expected result the test asserts. Each later task fills in the result columns
for the rows it covers: the automated spec that now holds the scenario, the live Chrome run, and
the manual real-browser results. The IDs are fixed; do not renumber them.

"M" is the manual pass on real Safari and real Firefox, run once per phase before that phase's
PR merges. Each phase gate runs the Playwright `firefox` project wherever it launches, and
records any machine where it does not (the macOS machine this was written on does not launch
it; see `e2e/README.md` Known gaps). The manual real-Firefox pass is required in addition to the
automated run.

Setup for each row lives in its Scenario text (for example, the throttle, fault, or account
it needs).

Result columns stay `—` until a task records a result. Record manual results with the browser
version.

| ID | Scenario | Expected | Engines | Phase | Automated in | Live Chrome run | Real Safari | Real Firefox |
|---|---|---|---|---|---|---|---|---|
| Q1 | Drop 50 mixed files (1 KB–40 MB, ~300 MB total), throttled to 2 MB/s, `test.setTimeout(30 min)` | at every 500 ms sample, rows in Starting, Resuming or Uploading (including finalizing) ≤ 3; start order = drop order; the next file starts only near the end of the one ahead | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | — | — | — |
| Q2 | Drop 300 files of 200 KB with the panel open | all complete; no main-thread long task > 200 ms during the run (PerformanceObserver `longtask`, Chromium only) | Chromium | 6 | — | — | — | — |
| Q3 | Two drops 2 s apart | the second drop's files start after the first drop's | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | — | — | — |
| Q4 | Rename a queued file | the asset is created with the new name | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | — | — | — |
| C1 | Cancel a queued file | the row disappears; no initiate for it (`countRequests`) | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | — | — | — |
| C2 | "Cancel all queued" mid-run | active files continue; every queued row disappears | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | — | — | — |
| C3 | Cancel the active file | the next file starts; `/upload/abort` sent once | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | — | — | — |
| U1 | `touch` a queued file before its turn | that row: "The file changed or was moved after it was added. Add it again.", Dismiss only; no initiate; the queue continues | Chromium, WebKit, Firefox | 3 | — | — | — | — |
| U2 | `remove` the sending file mid-part | the row ends Interrupted within 90 s + backoff; the queue continues; in WebKit the hang is broken by the watchdog | Chromium, WebKit, Firefox | 3 | — | — | — | — |
| U3 | `hangParts` for one file | parts are aborted after 90 s and retried; the queue does not freeze | Chromium, WebKit, Firefox | 3 | — | — | — | — |
| N1 | `context.setOffline(true)` at enqueue, back online after 30 s | rows show "Waiting for connection"; none failed; all complete after reconnect | Chromium, WebKit, Firefox | 3 | — | — | — | — |
| N2 | Offline mid-part for 20 s | the sending file's ladder recovers; queued files never fail | Chromium, WebKit, Firefox | 3 | — | — | — | — |
| S1 | `failInitiate` coded 503 three times | "Waiting for storage", then the queue continues; 3 retries spaced ≥ 5 s | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | — | — | — |
| S2 | `failParts(503)` on every PUT for 60 s | presign requests ≤ budget × 8 over the window (`countRequests`) | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | — | — | — |
| S3 | Infra: `docker stop` storage mid-queue, start after 60 s | queued files hold; the sending file ends Interrupted (as today) or recovers | Chromium | 6 | — | — | — | — |
| S4 | Infra: black-hole storage (`docker network disconnect`) | "Waiting for storage" within 20 s of the next file's turn | Chromium | 6 | — | — | — | — |
| R1 | Interrupt an upload (close the page), reopen, Resume while 10 files are queued | the Resume starts next; its `ff-uploads` entry exists throughout | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | — | — | — |
| R2 | Two tabs, Resume the same interrupted row in both | exactly one tab presigns | Chromium, WebKit, Firefox | 4 | — | — | — | — |
| R3 | Cancel during Resuming | the row returns to Interrupted; no `/upload/abort` | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | — | — | — |
| A1 | Two pages, one context: log out in B with files queued in A | A redirects to /login; after signing back in, A's queued files show as Failed with the signed-out message | Chromium, WebKit, Firefox | 4 | — | — | — | — |
| A2 | Accept an invite as `secondary` in tab B while A sends | A's sending row ends Interrupted; A's queued rows fail with the account message; no asset lands in `secondary`'s account | Chromium, WebKit, Firefox | 4 | — | — | — | — |
| A3 | Sign in as `secondary` in the same browser after `primary` left interrupted rows | `secondary` sees none of them; `primary` sees them again after switching back | Chromium, WebKit, Firefox | 4 | — | — | — | — |
| L1 | Reload with files queued | the beforeunload dialog appears (`page.on('dialog')`, type `beforeunload`) in Chromium and WebKit | Chromium, WebKit, Firefox | 5 | — | — | — | — |
| L2 | Log out with files queued | in-app confirm "N uploads will stop. Log out anyway?"; confirming navigates with no beforeunload dialog | Chromium, WebKit, Firefox | 5 | — | — | — | — |
| L3 | Expired session (clear both tokens, then trigger a request) | redirect to /login, no dialog | Chromium, WebKit, Firefox | 5 | — | — | — | — |
| V1 | New Version during a long queue | the asset page shows "New version queued, waiting for other uploads."; the version appears without reload | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | — | — | — |
| P1 | A storage cap that fits only about 3 of 10 files | at least one row Failed "Storage limit reached …" with Retry; every row ends Complete/Processing or Failed; none stays Queued or Starting; committed bytes exceed the cap by at most one file (with at most two files in flight; the cap counts only committed media) | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | — | — | — |
| P2 | Project deleted while 5 files are queued for it, plus 2 queued for another project | the 5 fail with 404; the 2 upload | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | — | — | — |
| M | Manual, **real Safari and real Firefox**, every phase: the phase's scenarios from this table, plus "hard reload, then drop from Finder without clicking, then reload". By the end, every scenario above has a real Safari and a real Firefox result | record the result in `SCENARIOS.md` with browser versions, before that phase's PR merges | Safari, Firefox (manual) | every phase | — | — | — | — |

## Phase 2 automated results

`tests/queue.spec.ts`, one `test()` per ID, run against the phase 2 branch (`feat/upload-queue-2-queue`
at `8a0411aa`) on the e2e stack. The whole suite per engine, 2026-10-21: setup, `fixtures.spec.ts`,
`queue.spec.ts` and `smoke.spec.ts`.

| Engine | Result | Duration |
|---|---|---|
| Chromium (Playwright 1.59, Chromium headless shell 1217) | 35 passed, 2 skipped (saved sessions reused); every queue scenario passes | 3.7 min, `queue.spec.ts` alone about 3 min |
| WebKit (Playwright 1.59) | 35 passed, 2 skipped; every queue scenario passes | 3.7 min |
| Firefox (Playwright's Firefox 1511) | **does not launch on this macOS machine** (Darwin 27): `browserType.launch: Timeout 180000ms exceeded`, the known gap in `README.md`. Not run. The scenarios are engine-neutral; run `pnpm test:firefox` wherever it launches, and do the manual real-Firefox pass | n/a |

Per scenario (seconds, Chromium / WebKit; commit `97d30912`): Q1 46 / 44, Q3 5 / 5, Q4 3 / 3, C1 2 / 3, C2 2 / 2,
C3 4 / 5, S1 18 / 18, S2 62 / 62, R1 6 / 6, R3 12 / 12, V1 4 / 4, P1 11 / 10, P2 4 / 5. After the fix round, R3
(deferred `/parts` answer) takes 4 / 7 s and S2 (20 parts) about 65 s on both.

What each one observed (both engines gave the same numbers unless noted):

- **Q1** 50 PNGs, 1 KB to 40 MB, 290 MB, throttled to 2 MB/s. 73 to 77 samples at 500 ms: at most 3 rows
  in Starting, Resuming or Uploading at any sample. 50 initiates, in drop order. At every initiate the
  files already running were at most 2, with at most 4 parts still to send (the start rule needs fewer
  than 3 files and fewer than 5 parts).
- **S1** the first of three 6 MiB files is refused three times (coded 503, `retry_after` 5), shows
  "Waiting for storage", the two behind it "Waiting to start"; four tries at least 5 s apart; no row fails.
  The files are over 5 MiB on purpose: a file of 5 MiB or less counts as one part while it initiates, so
  three of them ask at once and the three refusals land on three different files.
- **S2** one 200 MB file (20 parts, four times the budget), every part PUT answered 503 for 60 s: 25
  presign requests and 25 part PUTs (bound: budget 5 x 8 = 40). The row is still Uploading at the end.
  (With a 60 MB file of 6 parts the bound could not be exceeded even without the anti-storm rule, and the
  test survived removing it; with 20 parts that mutation gives 100 presigns and fails.)
- **R1** the interrupted row is a closed page reopened with its sessionStorage (so it is the same tab:
  a different tab would show the row as "Elsewhere" for 150 s). 13 files dropped (3 start, 10 wait), Resume:
  "Waiting to resume", and its parts listing is requested before the fourth file's initiate. Its `ff-uploads`
  entry is present at every write from the click until the upload is across; the app does not save a
  Processing or Ready row (it comes back from history), so "throughout" ends there.
- **P1** instance cap set to 3.5 files over what was used, part size set to 5 MiB (restored afterwards),
  ten 35 MiB files, parts throttled to 5 MiB/s so that at most two files are in flight: 4 accepted, 6
  refused with "Storage limit reached ...", Retry and Dismiss on each, initiate answers 200 x 4 then 400 x 6.
  Committed bytes ended 0.5 file over the cap. The files are 7 parts each on purpose: the cap counts only
  committed media, so with three small files in flight at once it can be exceeded by up to two files, not one.
- **P2** blockers on a third project hold the three places; 5 files for the project that is deleted and 2
  for another are queued by clicking through the app; the 5 fail (each initiate answered 404, the row says "not found",
  Dismiss offered), the 2 upload.

Each test was checked, on Chromium, against a temporary mutation of the app (reverted, never committed)
and failed for the intended reason: active cap 4 (Q1), a last-in-first-out queue (Q3), a queued Cancel that does nothing
(C1), "Cancel all queued" that does nothing (C2), no pump when a run ends (C3), the server's retry-after
ignored (S1), a Resume that goes to the back (R1), Cancel during Resuming that falls through (R3), no
queued line on the asset page (V1), initiate sending the file name instead of the renamed asset name (Q4),
a 404 treated as a hold (P2); the start rule's part-budget check relaxed by 3 parts (Q1: seven files started
with 5 or 7 parts unfinished, within Q1's normal 50 s); the anti-storm rule in the part budget removed (S2, with
20 parts). Not yet mutation-checked: P1.

Removing the part-budget check from the start rule outright made Q1 stall once, for 25 minutes. That was the
stack, not the mutation or the app: the Docker VM's disk was at 99%, so the e2e MinIO answered part PUTs with
507 Insufficient Storage, and every file then sat in the part retry ladder (about four minutes) holding its
place. The same mutation completes in 42 s when storage works (4 of 4 runs), and the unmutated app in the same
condition behaves the same way (13 minutes: 7 complete, 5 Interrupted after their ladders, 2 retrying, 36
queued). If a run stalls with 507s in the browser log, free space in the e2e MinIO first.

## Already covered

Phase 0 adds no scenario rows of its own. The existing specs cover groundwork the rows above
stand on:

- `tests/smoke.spec.ts`: signs in through the real login form, creates a project, drops a 3 MB
  PNG, and checks that it becomes one asset.
- `tests/fixtures.spec.ts`: checks that each fault and file helper (throttle, `failInitiate`,
  `failParts`, `hangParts`, `countRequests`, `touch`, `remove`) has its observable effect, so a
  scenario cannot pass on a fixture that silently does nothing.
