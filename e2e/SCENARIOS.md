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
| Q1 | Drop 50 mixed files (1 KB–40 MB, ~300 MB total), throttled to 2 MB/s, `test.setTimeout(30 min)` | at every 500 ms sample, rows in Starting, Resuming or Uploading (including finalizing) ≤ 3; start order = drop order; the next file starts only near the end of the one ahead | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#q1-drop-50-mixed-files-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#q1-pass) | — | — |
| Q2 | Drop 300 files of 200 KB with the panel open | all complete; no main-thread long task > 200 ms during the run (PerformanceObserver `longtask`, Chromium only) | Chromium | 6 | `tests/scale.spec.ts` (fixed APP-BUG-3 and APP-BUG-4 on the way) | final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#q2-pass) | — | — |
| Q3 | Two drops 2 s apart | the second drop's files start after the first drop's | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#q3-two-drops-2-s-apart-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#q3-pass) | — | — |
| Q4 | Rename a queued file | the asset is created with the new name | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#q4-rename-a-queued-file-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#q4-pass) | — | — |
| C1 | Cancel a queued file | the row disappears; no initiate for it (`countRequests`) | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#c1-cancel-a-queued-file-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#c1-pass) | — | — |
| C2 | "Cancel all queued" mid-run | active files continue; every queued row disappears | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#c2-cancel-all-queued-mid-run-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#c2-pass) | — | — |
| C3 | Cancel the active file | the next file starts; `/upload/abort` sent once | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#c3-cancel-the-active-file-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#c3-pass) | — | — |
| U1 | `touch` a queued file before its turn | that row: "The file changed or was moved after it was added. Add it again.", Dismiss only (no Retry); no initiate for it; the queue continues | Chromium, WebKit, Firefox | 3 | `tests/unreadable.spec.ts` | [PASS](live-runs/2026-10-22-phase-3.md#u1-touch-a-queued-file-before-its-turn-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#u1-pass) | — | — |
| U2 | `remove` the sending file mid-part | the row ends Interrupted with the same copy within 90 s + backoff (Chromium errors the send at once; in WebKit the send hangs with no event and the part watchdog ends it); nothing is aborted; the queue continues | Chromium, WebKit, Firefox | 3 | `tests/unreadable.spec.ts` | [PASS](live-runs/2026-10-22-phase-3.md#u2-rm-the-sending-file-mid-part-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#u2-pass) | — | — |
| U3 | `hangParts` / `stallParts` for parts of a file | the part watchdog aborts a part and retries it, and the queue does not freeze. A part that has sent its first byte and then stops is aborted after 90 s without upload progress. A part that has not sent a byte yet is aborted only when the whole tab has had no upload progress for 90 s, or when it has itself waited 5 min (the hard cap, so a part held behind busy sockets is not mistaken for a stalled one). A part that sent its last byte waits 5 min for the answer. The retry goes through; the 5 min cap alone is not automated (see Phase 3 results) | Chromium, WebKit, Firefox | 3 | `tests/unreadable.spec.ts` (U3: parts that never start, tab silent; U3b: a part that stops after progress, tab busy) | [PASS](live-runs/2026-10-22-phase-3.md#u3-parts-that-never-start-tab-silent-pass-stand-in-parts-held-nothing-sent), and [U3b](live-runs/2026-10-22-phase-3.md#u3b-a-part-that-stops-after-progress-tab-busy-pass-real-socket-stall-server) and [the two 5 min clocks](live-runs/2026-10-22-phase-3.md#u3c-the-two-5-min-clocks-u3s-text-the-5-min-cap-alone-is-not-automated-pass-real-sockets), run live; final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#u3-pass), [U3b](live-runs/2026-10-23-final.md#u3b-pass) and [U3c](live-runs/2026-10-23-final.md#u3c-pass) | — | — |
| N1 | `context.setOffline(true)` at enqueue, back online after 30 s | rows show "Waiting for connection"; none failed; all complete after reconnect (WebKit: `networkSwitch` aborts the API and bucket requests instead, see Phase 3 results) | Chromium, WebKit, Firefox | 3 | `tests/network.spec.ts` | [PASS](live-runs/2026-10-22-phase-3.md#n1-offline-at-enqueue-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#n1-pass) | — | — |
| N2 | Offline mid-part for 20 s | the sending file's ladder recovers; queued files never fail | Chromium, WebKit, Firefox | 3 | `tests/network.spec.ts` | [PASS](live-runs/2026-10-22-phase-3.md#n2-offline-mid-part-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#n2-pass) | — | — |
| S1 | `failInitiate` coded 503 three times | "Waiting for storage", then the queue continues; 3 retries spaced ≥ 5 s | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#s1-failinitiate-coded-503-pass-with-the-real-fault); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#s1-pass) | — | — |
| S2 | `failParts(503)` on every PUT for 60 s | presign requests ≤ budget × 8 over the window (`countRequests`) | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#s2-failparts503-for-60-s-pass-stand-in-network-errors); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#s2-pass) | — | — |
| S3 | Infra: `docker stop` storage mid-queue, start after 60 s | queued files hold; the sending file ends Interrupted (as today) or recovers | Chromium | 6 | `tests/infra.spec.ts` (`E2E_INFRA=1`) | final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#s3-pass) | — | — |
| S4 | Infra: black-hole storage (`docker network disconnect`) | "Waiting for storage" within 20 s of the next file's turn | Chromium | 6 | `tests/infra.spec.ts` (S4, and S4b with `docker pause`; `E2E_INFRA=1`; fixed APP-BUG-5 on the way) | final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#s4-pass) | — | — |
| R1 | Interrupt an upload (close the page), reopen, Resume while 10 files are queued | the Resume starts next; its `ff-uploads` entry exists throughout | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` (R1, and R1b, the APP-BUG-1 regression test, fixed 2026-10-22) | [PASS after the fix, 2026-10-22](live-runs/2026-10-22-phase-2.md#r1-re-run-after-app-bug-1-fix-pass) (first run: [FAIL, APP-BUG-1](live-runs/2026-10-22-phase-2.md#r1-interrupt-reopen-resume-while-files-are-queued-fail-app-bug-1)); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#r1-pass) | — | — |
| R2 | Two tabs, Resume the same interrupted row in both | exactly one tab presigns | Chromium, WebKit, Firefox | 4 | `tests/accounts.spec.ts` (failed in WebKit until the APP-BUG-2 fix, 2026-10-22) | [PASS, three runs](live-runs/2026-10-22-phase-4.md#r2-two-tabs-resume-the-same-interrupted-row-pass-three-runs); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#r2-pass) | — | — |
| R3 | Cancel during Resuming | the row returns to Interrupted; no `/upload/abort` | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#r3-cancel-during-resuming-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#r3-pass) | — | — |
| A1 | Two pages, one context: log out in B with files queued in A | A redirects to /login; after signing back in, A's queued files show as Failed with the signed-out message | Chromium, WebKit, Firefox | 4 | `tests/accounts.spec.ts` | [PASS](live-runs/2026-10-22-phase-4.md#a1-log-out-in-another-tab-with-files-queued-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#a1-pass) | — | — |
| A2 | Accept an invite as `secondary` in tab B while A sends | A's sending row ends Interrupted; A's queued rows fail with the account message; no asset lands in `secondary`'s account | Chromium, WebKit, Firefox | 4 | `tests/accounts.spec.ts` | [PASS](live-runs/2026-10-22-phase-4.md#a2-accept-an-invite-in-another-window-while-a-sends-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#a2-pass) | — | — |
| A3 | Sign in as `secondary` in the same browser after `primary` left interrupted rows | `secondary` sees none of them; `primary` sees them again after switching back | Chromium, WebKit, Firefox | 4 | `tests/accounts.spec.ts` | [PASS](live-runs/2026-10-22-phase-4.md#a3-another-account-in-the-same-browser-after-primary-left-interrupted-rows-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#a3-pass) | — | — |
| L1 | Reload with files queued | the beforeunload dialog appears (`page.on('dialog')`, type `beforeunload`) in Chromium and WebKit | Chromium, WebKit, Firefox | 5 | `tests/leave.spec.ts` (L1, and L1 negative: nothing on its way, no prompt) | [PASS](live-runs/2026-10-23-phase-5.md#l1-reload-with-files-queued-pass) (L1 negative: PASS, console not read), and [closing the tab](live-runs/2026-10-23-phase-5.md#l1-close-the-tab-with-files-queued-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#l1-pass) | — | — |
| L2 | Log out with files queued | in-app confirm "N uploads will stop. Log out anyway?"; confirming navigates with no beforeunload dialog | Chromium, WebKit, Firefox | 5 | `tests/leave.spec.ts` (L2 with Cancel then Log out, L2 one file, L2 negative: nothing on its way, no confirm) | [PASS](live-runs/2026-10-23-phase-5.md#l2-log-out-with-files-queued-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#l2-pass) | — | — |
| L3 | Expired session (clear both tokens, then trigger a request) | redirect to /login, no dialog; signed back in, the queued files are Failed ("Your session ended. Add these files again after signing in.") and the sending ones Interrupted | Chromium, WebKit, Firefox | 5 | `tests/leave.spec.ts` | [PASS, both tokens cleared and the refresh refused](live-runs/2026-10-23-phase-5.md#l3-a-session-that-ends-by-force-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#l3-pass) | — | — |
| V1 | New Version during a long queue | the asset page shows "New version queued, waiting for other uploads"; the version appears without reload | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#v1-new-version-during-a-long-queue-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#v1-pass) | — | — |
| P1 | A storage cap that fits only about 3 of 10 files | at least one row Failed "Storage limit reached …" with Retry; every row ends Complete/Processing or Failed; none stays Queued or Starting; committed bytes exceed the cap by at most one file (with at most two files in flight; the cap counts only committed media) | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#p1-storage-cap-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#p1-pass) | — | — |
| P2 | Project deleted while 5 files are queued for it, plus 2 queued for another project | the 5 fail with 404; the 2 upload | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#p2-project-deleted-under-queued-files-pass); final pass 2026-10-23: [PASS](live-runs/2026-10-23-final.md#p2-pass) | — | — |
| M | Manual, **real Safari and real Firefox**, every phase: the phase's scenarios from this table, plus "hard reload, then drop from Finder without clicking, then reload". By the end, every scenario above has a real Safari and a real Firefox result | record the result in `SCENARIOS.md` with browser versions, before that phase's PR merges | Safari, Firefox (manual) | every phase | n/a (manual); every cell of the two columns to the right is still empty, see [Manual pass owed](#manual-pass-owed-real-safari-real-firefox) | — | — | — |

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
20 parts); and, for P1, the start rule's part-budget check removed with the file cap kept (fails: committed bytes
55 050 240 over the cap where at most 36 700 160 are allowed, 1.5 files) and both checks removed (fails: no row refused, because
the cap counts only committed media and every file is in flight at once). P1 **survives** the start rule ignoring
`MAX_ACTIVE_FILES` alone, which is expected: its files are 7 parts, more than the budget of 5, so the part budget binds first and
the file cap never does.

Removing the part-budget check from the start rule outright made Q1 stall once, for 25 minutes. That was the
stack, not the mutation or the app: the Docker VM's disk was at 99%, so the e2e MinIO answered part PUTs with
507 Insufficient Storage, and every file then sat in the part retry ladder (about four minutes) holding its
place. The same mutation completes in 42 s when storage works (4 of 4 runs), and the unmutated app in the same
condition behaves the same way (13 minutes: 7 complete, 5 Interrupted after their ladders, 2 retrying, 36
queued). If a run stalls with 507s in the browser log, free space in the e2e MinIO first.

### After the stack reset (fix round 1, commit `4c7c3000`, 2026-10-21)

The e2e stack was recreated (`down -v`, `up -d --build`, Docker's build cache pruned) and the suites re-run on the fresh stack:

| Engine | Whole suite | `queue.spec.ts` alone |
|---|---|---|
| Chromium | 37 passed, 3.6 min (the setup project signed both accounts in through the form; the `test.fail()` fixtures test is drawn as a cross and counts as passed) | 13 of 13 passed, 2.8 min |
| WebKit | 35 passed, 2 skipped (saved sessions reused), 3.4 min | 13 of 13 passed, 2.8 min |
| Firefox | does not launch on this machine, as before | not run |

Per scenario in that full Chromium run (s): Q1 43.8, Q3 7.9, Q4 2.0, C1 3.3, C2 2.2, C3 3.5, S1 17.4, S2 66, R1 4.4, R3 3.2, V1 5.8,
P1 9.6, P2 3.6; WebKit: Q1 41.5, Q3 8.4, Q4 2.1, C1 2.0, C2 2.3, C3 3.7, S1 16.8, S2 60, R1 4.2, R3 3.0, V1 3.4, P1 9.5, P2 4.0.
After the live Chrome pass, Q3's initiate delay went from 1.2 s to 2.5 s (a margin for reading "Starting…"; Q3 then passed 8 of 8
repeats on Chromium and once on WebKit, 12 to 13 s each; one earlier Chromium run failed at its first wait and did not recur in 11 more
runs, its artifacts overwritten) and R1b was added: it reproduces APP-BUG-1 (below) and was marked `test.fail()`, so it passed while the
bug was there (drawn as a cross on both engines); the marker was removed with the fix (`42ed7643`). With it `queue.spec.ts` has 14 tests: the whole file on Chromium, 2026-10-22: 14 passed, 4.6 min (13 scenarios, R1b drawn as a cross).

## Phase 2 live Chrome results

Run by hand in real, headed Chrome 154.0.8037.100 on the phase 2 branch, 2026-10-22: [`live-runs/2026-10-22-phase-2.md`](live-runs/2026-10-22-phase-2.md),
with the before and after against the baseline. The "Live Chrome run" column above links each scenario's section.

- **Q1** at Fast 4G (the MCP has no 2 MB/s; same as the baseline): 6 initiates in the first second (baseline 50), at most 3 rows moving at all
  332 samples (baseline 50), start order exactly the drop order, at most 3 part PUTs in flight while throttled (baseline 61).
- **Passing** (13 asked for, 12 passed the first time, 13 after the R1 re-run): Q1, Q3, Q4, C1, C2, C3, S1 (with the real fault, `docker stop` of the e2e MinIO), S2 (25 presigns in 60 s, bound 40),
  R3, V1, P1 (0.5 file over the cap), P2. Plus the test plan's exploratory checks: 50 files at Slow 3G (one initiate at a time, three files sending),
  `/upload/initiate` blocked for 30 s ("Waiting for connection", none failed), and a Resume while 20 files wait (starts next).
- **R1 failed** in the first live pass (**APP-BUG-1**, fixed; see the re-run below): the Resume starts next, as expected, but a Resume that waits in the queue past the 30 s own-stop
  grace is read as "Still uploading in another tab or on another device" when its turn comes, and nothing is sent. Controlled
  reproduction and its control (the same Resume with no queue wait resumes) are in the report; `queue.spec.ts` R1b reproduces it.
- **R1 re-run after the fix** (`a1ac777e`, same real Chrome): **passes**. The Resume was clicked at heartbeat age 8.0 s and waited 38.6 s in the queue
  (46.6 s after the last heartbeat, past the 30 s grace); then it asked for its parts (`/parts` 200 with `server_time`), started next, sent the missing parts and
  completed, with its `ff-uploads` entry present throughout. The record is in the report ("R1 re-run after APP-BUG-1 fix"); the first failure is kept there as history.
- Not run here: the manual real Safari and real Firefox pass (matrix row M).

## Phase 3 automated results

`tests/unreadable.spec.ts` (U1, U2, U3 and its tab-busy twin U3b) and `tests/network.spec.ts` (N1, N2), run against
the phase 3 branch (`feat/upload-queue-3-stuck`) on the e2e stack, 2026-10-22. The three new fixture tests in
`tests/fixtures.spec.ts` (`hangParts` with `only`/`times`, `stallParts`, `networkSwitch`) ran with them.

| Engine | Result | Duration |
|---|---|---|
| Chromium (Playwright 1.59, Chromium headless shell 1217) | `unreadable.spec.ts` + `network.spec.ts` + `fixtures.spec.ts`: 30 passed, 2 skipped (saved sessions reused; the `test.fail()` fixtures test is drawn as a cross and counts as passed) | 5.8 min (the six scenarios alone: 5.0 min) |
| WebKit (Playwright 1.59) | the same: 30 passed, 2 skipped | 7.3 min |
| Firefox (Playwright's Firefox 1511) | **does not launch on this macOS machine** (Darwin 27), as before: `browserType.launch: Timeout 180000ms exceeded`, re-run 2026-10-22 on `U1`. Not run. The scenarios are engine-neutral; run `pnpm test:firefox` wherever it launches, and do the manual real-Firefox pass | n/a |

Repeats, to see whether any is flaky: Chromium U1, U2, N1 and N2 three more times each (12 passed, 5.2 min); WebKit U1, N1 and N2 twice
more (6 passed, 2.8 min); U3 and U3b passed twice on each engine and U2 twice on WebKit, all within a second of the times below. No retry was ever
needed (`retries` is 0). One earlier run of N1 on Chromium failed an assertion on the order of the creations, which was removed (see the
observation at the end of this section); one run of U1 on WebKit failed before `pngs` backdated its files (see the engine facts).

Per scenario (seconds, Chromium / WebKit): U1 2.6 / 2.4, U2 4.0 / 94.4, U3 94.5 / 94.1, U3b 99.6 / 94.1, N1 63.9 / 64.8, N2 33.0 / 33.0.

What each one observed:

- **U1** five 1 MB PNGs, parts on hold so three upload and two queue; the fourth is `touch`ed, then the hold is released.
  Its row fails with the exact copy, `data-detail` `failed`; it has Dismiss and no Retry and no Resume; no initiate was sent
  for it (so no asset and nothing to abort); the fifth file asked last and everything else completed; Dismiss removes the row.
- **U2** a 12 MB file (two parts) first of five, parts on hold, the file deleted, the hold released. Chromium errors the send at
  once: A is Interrupted with the exact copy 2.1 s after the release (one 2 s backoff, then the retry's read of the file fails).
  WebKit's send of the missing file hangs with no event; the part watchdog ends it at 90 s, the retry's read fails, and A is
  Interrupted with the same copy 92.3 s after the release. No `/upload/abort` was sent (the upload stays on the server for a
  resume), no part of A was sent a second time, and the four small files behind it were across.
- **U3** the first PUT of each of the three files that start is never answered and never sent (`hangParts({ times: 3 })`): the tab
  is silent from the start. For 70 s the three rows are Uploading, the other two Queued, nothing is retried, no
  row fails. Each part is aborted and sent again 92.1 to 92.3 s after its first PUT on both engines (the 90 s watchdog, 2 s
  backoff and a presign), the retries are answered 200, and then the two that were waiting start and everything completes.
- **U3b** a 20 MB file (two parts of 10 MB); one PUT is sent to a throwaway server on 127.0.0.1 (`stallParts`) that reads about
  256 KB and then stops reading. The browser reports real upload progress for it (1.1 MB in Chromium, 3.1 MB in WebKit) and then
  nothing. At 45 s a second, small file is sent in full, so the tab moves again. The stalled part is still
  aborted by its own clock, 97.3 s (Chromium) / 92.0 s (WebKit) after the stall began, and the retry goes to the bucket and
  completes. A watchdog that waited for the tab to be quiet would act at 137 s (see the mutation below).
- **N1** five 1 MB files dropped with the network down for 30 s. One row (the probe) reads "Waiting for connection" and the rest
  "Waiting to start" or, during a try, "Starting…"; none fails and none uploads; the probe asks 5 times in the 30 s (tries 0, 2, 6, 14
  and 30 s in, so the pauses are 2, 4, 8 and 16 s); nothing is created. After the network returns, everything is uploaded within
  about 32 s (the next try after the one at 30 s is due at 62 s; 32 s on both engines in the final runs, under a second in a run where a
  try happened to land just after the network was back), each file created once.
- **N2** five 3 MB files, three uploading with their parts on hold; the network goes down, the parts are released into it and
  20 s pass. The three rows stay Uploading and the two behind stay Queued throughout (no row failed, copy exact); no part was
  answered. After the network returns the retries of all three parts are answered and everything is uploaded 11 s later;
  the two that waited are created only after the network is back.

How U3 is designed. The watchdog has three clocks, so U3 covers them as far as an end-to-end run can:

- **a part that never sent a byte, tab silent** (U3): aborted 90 s after the tab's last progress (here, after the send).
- **a part that sent a first stretch and then stopped, tab busy** (U3b): aborted 90 s after its own last progress, however busy
  the tab is.
- **a part that never sent a byte while another part keeps the tab moving**: aborted at 5 min, the hard cap. **Not automated.** It
  needs a sibling that reports progress for 5 minutes without a break, and neither `throttleParts` (it holds a whole PUT,
  then sends it) nor `stallParts` (its progress ends within seconds) can make that. It is covered with a fake clock by
  `stores/__tests__/upload-store.test.ts` ("a part that never starts is given up on at 5 min even while another part keeps
  moving"), and so is the 5 min wait after a part's last byte.

Engine facts the scenarios stand on (measured; the README's Traps repeat the ones a test author needs):

- **WebKit compares a picked file's modification time at one-second resolution.** A `touch` 350 ms after the file was written was
  not noticed in one run of three, so U1 failed on WebKit until `pngs` backdated its files by a minute (3 of 3 after).
  A touched file is `NotReadableError` in Chromium and `NotFoundError` in WebKit; a deleted one is `NotFoundError` in both.
- **In Playwright's WebKit `context.setOffline(true)` also makes files unreadable**: `file.slice(0, 1).arrayBuffer()` rejects with
  `NotReadableError` while it is on (and `new Response(blob)` with a `TypeError`), and returns when it is turned off. With it, the app
  correctly reads every dropped file as one that changed and N1 fails all five rows with the changed-file copy. So `networkSwitch`
  uses `setOffline` on Chromium (and Firefox) and, on WebKit, a route that aborts every request to another origin than the app's
  with "internet disconnected". Both give the app a network error on every API and bucket call.
- **WebKit reports a small part as sent before the server has read it**: a 2 MB part PUT to a server that had read 311 KB took the
  row to "Finalizing…", the app's "every byte of this file is sent" (so such a part waits on the 5 min answer clock, not the 90 s one). The stalled part of U3b is therefore a part of
  10 MB, which both engines report as partly sent.
- **Chromium reads a deleted file as an empty one if nothing has asked its size yet** (`size` 0, `slice().arrayBuffer()` resolves
  with no bytes). The app reads `file.size` when the file is added, so after that Chromium reports `NotFoundError` as above.

Each test was checked against a temporary mutation of the app (reverted, never committed; `apps/` is clean) and failed for the
intended reason:

| Mutation | Test, engine | Result |
|---|---|---|
| the readability probe at a new file's turn skipped | U1, Chromium | fails: D never reads Failed; it is created and ends Interrupted (the retry's probe) after the 60 s wait |
| no readability probe before a part retry | U2, Chromium | fails: A is still Uploading after 4 min (the retry ladder keeps sending it) |
| the watchdog never fires (both limits 2 000 000 000 ms) | U2, U3, U3b, WebKit | all three fail by timeout: A still Uploading after 4 min; three rows Uploading and two Queued after 3 min; A still Uploading after 2.5 min |
| `PART_STALL_MS` 30 s | U3, Chromium | fails: at 35 s every part has already been retried (the watchdog acted before 90 s) |
| a part that has started is judged by the tab's silence, not its own | U3b, Chromium | fails: the retry came 137.6 s after the stall began, bound 125 s |
| a network error at initiate refuses the file | N1, Chromium | fails: all five rows Failed "Failed to fetch", none ever Waiting for connection |
| a network error on a part is final | N2, Chromium | fails: three rows Interrupted "Part 1 failed: network error" within 3 s of the release |

The first attempt at the "tab's silence" mutation, run straight after the edit, failed differently (the stalled part was retried 22 s
after it began and A was complete before 45 s; a dev-server reload right after an edit is the likely cause, not confirmed). The repeat,
with the edit settled, failed on the intended bound as above.

Observation for the app, not asserted (N1): when several files ask at once and all fail with a hold, the one that fails first is the
probe and the others are put back at the front in the order their failures arrive, which is arbitrary. In one Chromium run of N1 the files
were created in the order 01, 03, 02, 04, 05 (in the one later run that logged the order it was 01, 02, 03, 04, 05). Files of 5 MiB or less count as one part while they initiate,
so the first three do ask together. No data is lost; the order among those three can change after an outage.

## Phase 3 live Chrome results

Run by hand in real, headed Chrome 154.0.8037.100 on the phase 3 branch (`0eb50cc1`), 2026-10-22: [`live-runs/2026-10-22-phase-3.md`](live-runs/2026-10-22-phase-3.md).
The "Live Chrome run" column above links each scenario's section.

- **Passing**: U1, U2, U3, N1, N2, plus the checks the test plan asked for and two the live pass added: U3b (a part that sent 1.08 MB and
  then stopped, tab busy: aborted 90.0 s after its own last progress, not 140 s), U3c (the two 5 min clocks the automated suite cannot
  run: a never-started part with a busy tab is aborted at 300.0 s, a part with every byte sent and no answer 299.98 s after its last
  byte), `rm` of a file that is sending (X1: all parts in flight, the upload completes from the unlinked file; X1b: a part still to
  start fails at once and the row is Interrupted with the changed-file copy 2.1 s later), DevTools offline for 125 s with a part in
  flight (X2b: the row holds at "Uploading", queued rows "Waiting for connection", everything completes 26 s after the network
  returns with no click), and the three changes a sync client makes to queued files (X3: touch, replace by rename, in-place rewrite:
  all three Failed with the exact copy, no initiate for any).
- **No app bug was found** in this pass. Observations (not failures): after a reconnect the app waits out its backoff (22 to 30 s here)
  rather than waking on the browser's `online` event; an outage that lands on `/upload/complete` leaves the row Interrupted with the
  browser's text "Failed to fetch" (X2), recoverable with Resume without re-sending.
- **Laptop sleep: moved to the manual pass** (an automated run does not put the machine to sleep).
- "Touch a file in a synced folder" used a plain local folder: the Google Drive, OneDrive and iCloud folders on the machine are the
  user's, not test locations.
- Not run here: the manual real Safari and real Firefox pass (matrix row M).

## Phase 4 automated results

`tests/accounts.spec.ts` (A1, A2, A3, R2), run against the phase 4 branch (`feat/upload-queue-4-accounts`) on the
e2e stack, 2026-10-22. Every test runs two pages of one browser context, which share localStorage as two tabs of one
browser do, so a sign-in or log out in one reaches the other as a `storage` event.

| Engine | Result | Duration |
|---|---|---|
| Chromium (Playwright 1.59, Chromium headless shell 1217) | `accounts.spec.ts --repeat-each=3`: 12 of 12 passed (setup skipped, saved sessions reused) | 9.5 min |
| WebKit (Playwright 1.59) | the same: 12 of 12 passed | 9.7 min |
| Firefox (Playwright's Firefox 1511) | **does not launch on this macOS machine** (Darwin 27), as before. Not run. The scenarios are engine-neutral; run `pnpm test:firefox` wherever it launches, and do the manual real-Firefox pass | n/a |

Per scenario (seconds, Chromium / WebKit, the three runs): A1 9.7 8.8 8.7 / 11.6 11.6 11.4, A2 6.1 5.9 5.6 / 6.2 6.5 6.5,
A3 7.3 8.6 7.4 / 8.0 9.0 9.1, R2 166 166 166 / 167 167 168 (R2 waits out the 150 s live window first). No retry (`retries` is 0),
no flake. The whole suite afterwards (every spec, setup included), on the code of this commit: 98 passed, 2 skipped (saved sessions
reused), 26.7 min: 49 per engine, the previous 45 and these 4 (the `test.fail()` fixtures test is drawn as a cross and counts
as passed).

The first whole-suite run, before `0d574180`, failed `queue.spec.ts` R1 once in WebKit: its check that the resumed row was
saved throughout stopped counting writes 250 ms before the completion's answer, and once the resume claims its row
(APP-BUG-2 below) it sends after the queue ahead of it has drained, two parts and a completion in 230 to 340 ms (measured),
so the window could leave out every write of the send (2 of 5 runs). R1 now stops at the moment the completion went out,
which is sound without a margin; 10 of 10 runs passed the check after the change. Separately, R1 in WebKit sometimes never
sees its first upload start ("Timed out after 60000 ms waiting for the upload hanging", the drop lands nowhere): 1 in 10
with the fix and 1 in 12 on the app before it, so it is not from this change (pre-existing, not chased here).

What each one observed:

- **A1** five 1 MB PNGs, parts on hold: three uploading, two queued. B logs out through the sidebar menu. In A the two queued
  rows are saved at once as Failed, "Signed out in another tab. Add these files again after signing in.", with primary as
  owner, and nothing is sent for them. On release the three that had started send their already-presigned parts and then
  nothing more (no `/upload/complete`: it would need the owner's token), and are saved Interrupted. A goes to `/login` with
  no prompt at its next request to the API: the person opens Notifications, the request answers 401, there is no refresh
  token, and `clearTokens` sends the page to `/login` (the spec's "Token removed" chain). Nothing in A asks the server
  anything on its own once its uploads have stopped, so A does not move until the tab is used. B then signs in as
  `secondary`, whose panel shows none of these rows. A signs back in as primary through the login form it was sent to: the
  two queued rows are Failed with the signed-out message, the three others Interrupted.
- **A2** a new user is invited through the admin API each run and made an editor of the project, so a file sent with their
  token would be accepted and land in their account. Same frozen queue in A; B opens `/invite/<token>` and accepts it
  through the form. In A the two queued rows are saved at once as Failed with "Another account signed in. Add these files
  again after signing back in.", primary's; the three sending end Interrupted, primary's; A's panel now shows the invitee's
  uploads, none of these. No initiate for a queued file and no completion was sent. The invitee's
  `/me/assets?filter=owned` is empty, while primary's lists exactly the three that started (so the check sees unfinished
  uploads at all). Back as primary, A shows them again: two Failed with the account message, three Interrupted.
- **A3** two uploads of primary's are interrupted by closing their page (parts hang), and the closed tab is reopened: both
  Interrupted. In B primary logs out and `secondary` signs in: A's panel at once shows none of them, B's neither, and the
  name is nowhere on B's page; both rows are still saved, Interrupted, with primary as owner. B logs out and primary signs in
  again: A shows both Interrupted again, and so does B (Interrupted or, for its 150 s window, Elsewhere: B is another tab).
- **R2** a 12 MB upload (two parts) interrupted by closing its page, then 160 s for the closed tab's last heartbeat and the
  server's last sight of it to leave the live window (inside it both new tabs read Elsewhere and offer no Resume). Two new
  tabs show it Interrupted; each clicks Resume and opens its file picker, then both pick the file at once. Both ask
  `/parts` in the same millisecond or the next. In all six runs after the fix exactly one tab presigned (2 presigns, 2 PUTs,
  1 completion) and the other showed Elsewhere and sent nothing.
  Before the fix Chromium passed R2 3 of 3; only WebKit exposed the race, so R2 is no guard for it in Chromium: the unit
  tests named below are the regression guard.

**APP-BUG-2 (fixed, `71793505`): two tabs resuming at once both sent the upload.** Before the fix R2 failed in WebKit in
2 of 3 runs (Chromium passed 3 of 3): both tabs asked `/parts` at +0 ms, both presigned and PUT both parts, and both
completed; in one run one tab was then left Failed, "Upload is incomplete: 1 part(s) missing, starting at part 1.". Each tab
looks in shared storage for the other's heartbeat once `/parts` answers (spec goal 11, step 2), and a write to localStorage
reaches another tab's process a moment later, so each looked before the other's first stamp arrived. Now a resume that
has been told nobody is sending writes a claim (one key per upload, `ff-upload-claim:<version id>`), waits 500 ms for a competing
claim still on its way, and goes on only if its claim stands; the other shows Elsewhere. The unit test in
`upload-other-tab.test.ts` ("two tabs resuming the same upload at the same moment") reproduces it: the other tab's moves
land just after this tab has looked, and before the fix this tab sent and completed. The same describe and "two tabs of
one browser" in `upload-queue-resume.test.ts` also cover a claim on another row written from a stale view of storage, a
claim value that cannot be read, and an account change while the claim settles (review fix round, 2026-10-22).

Each scenario was checked, on Chromium, against a temporary mutation of the app (reverted, never committed) and failed
for the intended reason: the `storage` listener for the token ignored (A1 and A2 fail: the queued rows are not failed when
the other tab logs out or signs in), and every account's rows shown to whoever is signed in (A3 fails: `secondary` sees
primary's rows). R2 failed on the app as it was before the APP-BUG-2 fix (above).

Observations (not failures of these scenarios):

- **A pre-existing sign-in trap, not fixed here.** If A's next request is a click on a link (the sidebar's Projects) rather
  than an API call, the middleware answers it (the cookies are gone) and Next's client router lands on
  `/login?from=%2Fprojects`. Signing in on that page then does nothing: the login form's `router.replace('/projects')`
  reuses the redirect the router remembers, the URL stays `/login?from=%2Fprojects` (measured: no request at all, and 35 s
  later only a refetch of the login page), and the person sits on the login page with valid tokens until a reload. The
  login code is the same as on `main`; it is not part of the upload queue. A1 therefore makes its next request an API call
  (Notifications), the path the spec names.
- The A2 invitee address is `e2e-invitee-<ms>@example.com`: the API refuses the reserved `.test` domain (422,
  "special-use or reserved name"). The test deactivates and deletes its invitee when it ends.
- Not run here: the manual real Safari and real Firefox pass (matrix row M). The live Chrome pass is below.

### Phase 4 gate (2026-10-22, at `641c1461`)

- Chromium: the whole suite, 49 passed, 2 skipped (12.5 min).
- WebKit, first run: 47 passed, 2 failed (R2, and the fixture test `countRequests()`), with `accounts.spec.ts` taking 40 min,
  longer than its four tests' time limits added together. The run's artifacts were overwritten by the Firefox run that followed, so
  the cause is not known; a stalled browser or stack is the likely reading, not confirmed. Re-run straight after: `accounts.spec.ts`
  alone 4/4 (3.2 min), the whole suite 49 passed, 2 skipped (13.3 min), then R2 three more times, 3/3. R2 has passed 8 WebKit runs in a
  row since the APP-BUG-2 fix; watch it in the Phase 5 and 6 gates.
- Firefox (Playwright `firefox` project): does not launch on this Mac (macOS 27, `firefox-1511`): `browserType.launch` times out
  after 180 s with `sandbox_extension_issue_file_to_process failed ... Operation not permitted`. No test ran.
- Not run yet: the manual real Safari and real Firefox pass of this phase's scenarios (row M), owed before PR 4 merges.

## Phase 4 live Chrome results

Run by hand in real, headed Chrome 154.0.8037.100 on the phase 4 branch (`75618d4b`), 2026-10-22, with two tabs and two windows of
one profile: [`live-runs/2026-10-22-phase-4.md`](live-runs/2026-10-22-phase-4.md). The "Live Chrome run" column above links each
scenario's section. The DevTools MCP's profile was held by a Chrome the pass had not started, so the pass drove its own headed
Chrome over the DevTools protocol (`live-tools/cdp-driver.js`, `LIVE-CHROME.md` section 10). Through that driver every page read visible and
focused (Playwright's focus emulation), so the throttling of a hidden tab or an occluded window (which bears on the claim settle and
the heartbeat) was not exercised in any multi-tab step (A1, A3, R2 and its two variants); that is owed to the manual pass (row M).

- **Passing**: A1, A2, A3 and R2, plus the test plan's three checks:
  - A1: the log out in tab B failed A's two queued rows at once with the signed-out copy, kept for primary; the three sending sent
    their presigned parts and stopped, Interrupted, with no completion; A went to `/login` 0.38 s after its next API call
    (Notifications), with no prompt; back as primary the rows were as left, and Resume completed one without re-sending.
  - A2: an invite accepted in window B failed the two queued rows with "Another account signed in", left the three sending
    Interrupted, and **every upload request was sent as primary** (recorded per request from the token's `sub`); the invitee
    owns nothing.
  - A3 and Local Storage: each account's rows are hidden from the other and stay in `ff-uploads` with their owner (11 of
    primary's through secondary's session, secondary's one through primary's); each sees its own again.
  - R2: three runs (two windows; two tabs of one window; two windows with both `/parts` answers handed over in the same
    millisecond, so both tabs wrote a claim at once): each time exactly one tab presigned and completed, the other showed
    Elsewhere and sent nothing.
  - Token expiry (1-minute tokens on the dev stack): one tab's three `/upload/complete` answered 401, one refresh, all resent 180 ms
    later as the same account; no account message. A refresh that goes out offline (T2, with the `holdRefresh` stand-in, which
    holds the refresh until the network is off) leaves the rows "Waiting for connection" and the tokens in place, and the queue
    goes on 2.3 s after the network returns. 40 s offline across the token's expiry (T3: parts held by `hold()` and released into
    the outage, never cut mid-PUT; no refresh went out offline) left the rows Uploading and Waiting to start, and the queue went on
    at the ladder's next rung, 23.9 s after the network returned. None failed with "Another account signed in".
- **No app bug of the upload queue was found.** One uncaught error was seen: a signed-out tab opening Notifications rejects a
  promise nobody handles (`ApiError: Not authenticated`); `notification-store.ts` and its drawer are unchanged from `main` (read in
  the code, not reproduced on `main`), so it is reported, not fixed, ticket to be filed. A1 is PASS under the exception now in
  `LIVE-CHROME.md` section 5 item 3, declared as a deviation in the report. Also seen, not failures: rows added in one tab are not listed in another tab of the same account until an
  account change or a history load (as on `main`); a second open tab keeps the uploading tab's token fresh, so the 401 path shows
  only with one tab.
- Not run here: the manual real Safari and real Firefox pass (matrix row M).

## Phase 5 automated results

`tests/leave.spec.ts` (L1, L2, L3, and a negative for each of L1 and L2), run against the phase 5 branch
(`feat/upload-queue-5-leave`) on the e2e stack, 2026-10-23. Each test clicks the page before it leaves (the panel's
Uploads button and All tab), since a browser prompts only a page that has had a user interaction; the negatives click too.

| Engine | Result | Duration |
|---|---|---|
| Chromium (Playwright 1.59, Chromium headless shell 1217) | `leave.spec.ts --repeat-each=3`: 18 of 18 passed (setup skipped, saved sessions reused) | 46.1 s |
| WebKit (Playwright 1.59) | the same: 18 of 18 passed | 54.4 s |
| Firefox (Playwright's Firefox 1511) | **does not launch on this macOS machine** (Darwin 27), as before. Not run. Run `pnpm test:firefox` wherever it launches, and do the manual real-Firefox pass | n/a |

**L1 has not been run on Firefox**: Playwright's Firefox does not launch on this Mac, so whether and how Firefox raises the
prompt here is unmeasured (owed to a machine where it launches, and to the manual real-Firefox pass).

Per test (seconds, Chromium / WebKit, the three runs): L1 3.6 3.4 3.4 / 4.0 3.7 3.7, L1 negative 2.0 2.0 2.1 / 2.1 1.9 1.9,
L2 3.4 3.3 3.1 / 4.0 4.0 4.1, L2 one file 2.1 2.1 2.1 / 2.6 2.6 2.7, L2 negative 1.9 1.9 1.9 / 2.3 2.3 3.6, L3 1.9 1.6 1.7 /
1.8 1.9 3.0. No retry (`retries` is 0).

What each one observed:

- **L1** five 1 MB PNGs, parts on hold: three Uploading, two Queued. `page.reload()` raises a dialog of type
  `beforeunload`. Dismissed, the document stays (a marker set on `window` is still there a second later) and the five rows
  read exactly as before. Reloaded again (after another click) and accepted, the page reloads: the three that had started
  come back Interrupted (asserted). The two that were queued were not listed after the reload in these runs; that is not
  asserted (the row does not ask for it, and keeping never-started files across a reload is a non-goal of the design, not
  a promise either way). **L1 negative**: one PNG uploaded to Ready, then a reload: no dialog,
  and the document is replaced.
- **L2** (as `secondary`) the same frozen queue; Log out from the sidebar's account menu opens the in-app confirmation titled
  exactly "5 uploads will stop. Log out anyway?". Cancel closes it, both tokens are unchanged, `<body>` is not left at
  `pointer-events: none`, the next clicks land (the Uploads panel opens, the rows are as they were, the account menu opens
  again). Log out again and confirm: `/login`, both tokens gone, no `beforeunload` dialog. **L2 one file**: the title reads
  "1 upload will stop. Log out anyway?", and confirming leaves with no dialog. **L2 negative**: with one upload Ready and
  nothing on its way, Log out goes straight to `/login`; a `MutationObserver` watching for any `role="dialog"` (its finding
  kept in sessionStorage across the load) saw none, and there was no browser prompt.
- **L3** the same frozen queue (as primary), then both tokens are removed from localStorage in the page itself (no `storage`
  event, so nothing reacts: the three sending rows are still saved as `uploading`). Opening Notifications asks the API,
  which answers 401; with no refresh token `clearTokens` sends the page to `/login`, with no dialog.

**Engine quirk: how Playwright reports a dismissed `beforeunload`** (measured in both engines, Playwright 1.59, recorded in
the spec's header). Every way of leaving shows the prompt as a `dialog` of type `beforeunload`, and accepting it lets every
one of them through. Dismissing it:

| Navigation | Chromium | WebKit |
|---|---|---|
| `page.reload()` | the promise never settles (runs to its timeout) | rejects, "navigation cancelled by beforeunload dialog" |
| `page.goto(url)` | rejects, `net::ERR_ABORTED` | the promise never settles (runs to its timeout) |
| `page.evaluate(() => location.reload())` | resolves | resolves |
| `page.close({ runBeforeUnload: true })` | resolves, the page stays open | resolves, the page stays open |

So L1 reloads with `page.reload()` (the browser's own Reload, not a script's) without awaiting it when the prompt is
dismissed: it awaits the dialog event, then looks at the page.

Each scenario was checked against a temporary mutation of the app (reverted, never committed; `apps/` clean afterwards),
in the engines each bullet names, and failed for the intended reason:

- `useUploadLeaveGuard()` not mounted in `app/(dashboard)/layout.tsx`: **L1 fails** (no dialog within 15 s), in Chromium and
  in WebKit. Everything else passes, as it should: they all expect no prompt.
- the sidebar's Log out calling `logout()` directly, with no confirmation: **L2 and L2 one file fail** (no confirmation;
  the page is already on `/login`), in Chromium.
- `clearTokens` no longer setting the suppression flag: **L2, L2 one file and L3 fail** with a `beforeunload` dialog on the
  way to `/login`, in Chromium and in WebKit (L3 checked again on Chromium against the final spec).

One check does **not** catch its mutation: L2's "Cancel leaves the page clickable" (`<body>` not at `pointer-events:
none`, and the next click lands). With `e31deb08`'s handoff reverted (the sidebar's `requestLogout` calling `setLogoutAsk`
inside the menu's `onSelect` instead of through `afterMenuCloses`), L2 still passed, twice in Chromium and twice in WebKit
(fix round 1, 2026-10-23). The web container has one copy of Radix's `react-dismissable-layer` (1.2.1), and the lock that
handoff prevents comes from duplicate layers, which this stack cannot reproduce. The check stays as a guard against a lock
left behind for any other reason; the handoff itself is pinned by the jsdom unit test "asks only once the menu has let go
of the page" (`components/layout/__tests__/sidebar-logout-confirm.test.tsx`).

The spec's 429 diagnostic was checked once by hand (fix round 1): a temporary test that fulfils `GET /me/notifications`
with 429 and no CORS header through `page.route`, then fails on purpose, ended with "The API answered 429 (its per-account
read limit) 2 times during this test" in Chromium and in WebKit (both counted as responses). A real 429 reached WebKit as a
failed request only (its error text names the status), and the diagnostic fired on it during development ("22 times").

After fix round 1 (the wording above, L1 no longer checking the never-started rows), `leave.spec.ts` was run once per
engine: Chromium 6 of 6 (17.7 s), WebKit 6 of 6 (18.2 s).

**No app bug of the upload queue was found.**

Observations (not failures of these scenarios):

- **These short tests can spend the API's per-account read limit.** `GlobalRateLimitMiddleware` allows each account 600
  reads a minute. One of these tests reads about 30 times in 2 to 4 s (the dev server's strict mode asks twice for most
  things), so with every test signed in as primary, a WebKit `--repeat-each=3` was refused with 429 on its 18th test in two runs
  of two, and runs started within a minute of another failed earlier (traces: the failed requests read "Status code:
  429"). After the split below, a Chromium run started straight after a WebKit run still met one 429, on its 2nd test. The L2 tests now sign
  in as `secondary`, which halves each account's share, and the spec counts 429s and names them when a test fails. Wait a
  minute between back-to-back runs of this file.
- **A 429 from the API has no CORS header** (the browser reports "not allowed by Access-Control-Allow-Origin. Status code:
  429"), so the page sees a network failure, cannot read `Retry-After`, and SWR retries into the same window. Pre-existing,
  not part of the upload queue; not fixed here.
- **A drop on a project page before it knows the account's role goes nowhere, silently.** The role comes from the
  project's members matched against `/auth/me`, and until both answer it is "viewer". The drop region's handlers are
  attached all along but return early while it is not enabled (`useFileDropRegion`), so the drop is ignored (no row, no
  message). With the API answering normally that window is well under a second; under the 429s above it lasted
  the whole test. The spec waits for the header's Upload button (drawn on the same condition) before dropping. The same
  window is the likely cause of the Phase 4 note that R1 in WebKit sometimes "never sees its first upload start" (not
  re-measured there); `dropFiles` could wait for it too.
- Not run here: the manual real Safari and real Firefox pass (matrix row M), which also owes "hard reload, then drop from
  Finder without clicking, then reload". The live Chrome pass is below.

### Phase 5 gate (2026-10-23, at `dd623474`)

- Chromium: the whole suite, 55 passed, 2 skipped (12.8 min).
- WebKit: the whole suite, 55 passed, 2 skipped (14.4 min). No flake this time, including R1 and R2.
- Firefox (Playwright `firefox` project): still does not launch on this Mac (`browserType.launch` times out after 180 s,
  `sandbox_extension_issue_file_to_process failed ... Operation not permitted`). No test ran.
- Web unit suite 148 files, 1485 tests; `tsc --noEmit` clean; lint 18 warnings, 0 errors; API suite 1563 passed, 3 skipped,
  2 failures that predate this work (`test_deleted_project_routes` metadata-field cases).
- Not run yet: the manual real Safari and real Firefox pass of L1-L3 (row M), owed before PR 5 merges. It should also cover what
  the live pass could not: the wake lock in a truly hidden tab (W4), whether the short lock pulses on each retry during a hold
  keep the machine awake (`pmset -g assertionslog` with an idle display), and the leave prompt seen on screen.

## Phase 5 live Chrome results

Run by hand in real, headed Chrome 154.0.8037.100 on the phase 5 branch (`eeb6048d`), 2026-10-23 (19:03 to 19:20 UTC on the
22nd): [`live-runs/2026-10-23-phase-5.md`](live-runs/2026-10-23-phase-5.md). The "Live Chrome run" column above links each
scenario's section. The DevTools MCP's profile was again held by a Chrome the pass had not started, so the pass drove its own
headed Chrome over the DevTools protocol (`live-tools/cdp-driver.js`, `LIVE-CHROME.md` section 10). The wake lock was watched from
outside the app (`live-tools/ffq-wakelock.js`, a wrapper on `WakeLock.prototype.request` installed before the app runs) and
from the OS (`pmset -g assertions`: Chrome's "Blink Wake Lock" assertion).

The wake-lock checks have no rows of their own in the matrix; the live report labels them:

- **W1**: the lock while six files send (`Fast 4G`).
- **V**: the lock given up when the tab is hidden and taken again when it is shown (a real tab switch).
- **W2** and **W2b**: the lock during a storage hold ("Waiting for storage"; 3 and 9 refused initiates).
- **W3**: the lock while rows only wait (offline, "Waiting for connection").
- **W4**: the lock when another tab of the same browser signs out, then signs back in.

**Visibility caveat.** Through the driver every page reads visible (Playwright's focus emulation, which a second DevTools
session cannot turn off: measured). The re-acquire on visibility (V) was therefore run with the driver stopped, over a plain
DevTools connection (`live-tools/cdp-raw.js`), with a real foreground tab and a real tab switch back; no minimize. Every other
step ran with every page treated as visible, so a hidden tab's timer throttling was not in play there. **W4 is the weakest of
these**: its uploading tab was a background tab that the emulation reported visible, so W4 shows only the app's own logic
(release on the other tab's sign-out, a new request on sign-in). It is not what a real browser does with that tab: a truly
hidden tab holds no wake lock (the browser drops it on hide, as V measured), and the re-request on sign-in would be refused
until the tab is shown. The real-browser outcome of W4 is owed to the manual pass.

- **Passing**: L1, L2, L3 and the test plan's checks:
  - L1: a Reload with 3 sending and 2 queued raised Chrome's own `beforeunload` 4 ms later; Stay (dismissed after 3 s, the page
    held meanwhile) kept the document, the rows and the wake lock; Leave reloaded and the three that had started came back
    Interrupted. A Reload with only Interrupted rows asked nothing. **L1 negative** (a Reload with nothing on its way): no
    prompt, **PASS (console not read)**. Closing the tab (`Page.close` with `beforeunload`) asked each time: the first close
    with 3 sending and 0 queued (two queued rows had been cancelled by a tooling slip), the second and third with 3 sending and
    2 queued; Stay kept the tab, Leave closed it.
  - L2: "5 uploads will stop. Log out anyway?" opened 13 ms after the account menu closed; Cancel kept the tokens, the rows, the
    lock and a clickable page; Log out went to `/login` with no browser prompt. "1 upload will stop. Log out anyway?" behaved the
    same. With nothing on its way Log out asked nothing.
  - L3: with both tokens removed nothing reacted until the next request (401), then `/login` 0.43 s later with no prompt; with
    both tokens spoiled the server refused the refresh (401) and the page was on `/login` 0.5 s after the first 401, no prompt.
  - Wake lock: **W1, PASS (console not read)**: one lock from 12 ms after the drop to the moment the last of six files went to
    Processing, never re-asked between files. W2b and W3, PASS: during a 35 s "Waiting for storage" hold and a 62 s offline wait
    no lock was held between tries, and each probe try took it for 3 to 11 ms. **V, PASS (console not read)**: hidden by a real
    tab switch, the browser dropped it, and the app asked again in the same millisecond the tab was shown. W4, PASS for the
    app's logic only (see the caveat): a sign-out in another tab released it at once, and signing back in took it again while
    the rows still moved. While on a hold the leave warning stays armed though the lock is not (by design).
- **No app bug was found** in what was read. The console was **not read** for W1, V and the L1 negative (the first driver
  session's records ended with it, and V ran with no recorder), so an uncaught error there would have gone unseen; every other
  step's console was read and had none. Observations (not failures): a hold costs one short lock per probe try (whether those
  pulses reset the OS idle timer was not measured, see the live report); leaving the page in the tab that ends the session
  reaches `pagehide` with the lock held and the browser drops it with the document; the queue does not wake on `online` (29.8 s
  in W3, as in phase 3); own-tab Log out and Leave lose the never-started rows, which the confirmation's count includes.
- Not run here: the manual real Safari and real Firefox pass (matrix row M), W4 with a truly hidden tab, the idle-timer check
  above, and a view of the dialog itself on screen (the driver answered it after 1.5 to 3 s; `screencapture` lacked permission).

## Phase 6 automated results

`tests/scale.spec.ts` (Q2) and `tests/infra.spec.ts` (S3, S4, and S4b, the same scenario with `docker pause`), run
against the phase 6 branch (`feat/upload-queue-6-polish`) on the e2e stack, 2026-10-23. The infra specs are skipped unless
`E2E_INFRA=1`; they stop, unplug or pause the stack's real MinIO through `fixtures/stack.ts` (`stopStorage`, `startStorage`,
`blackholeStorage`, `restoreStorage`), which act only on the `ffe2e-` stack's MinIO container and put it back in `afterEach`,
pass or fail, waiting for `/minio/health/live` on the host port before the next test.

| Spec | Engine | Runs after the fixes | Duration |
|---|---|---|---|
| `scale.spec.ts` (Q2) | Chromium (Playwright 1.59, Chromium headless shell 1217) | 2 of 2 passed | 28 to 31 s each |
| `scale.spec.ts` (Q2) | WebKit (Playwright 1.59) | 2 of 2 passed (completion only: WebKit reports no `longtask` entries) | 32 to 40 s each |
| `infra.spec.ts` (S3, S4, S4b), `E2E_INFRA=1` | Chromium | 3 of 3 passed, 3 of 3 tests each time (S3 also passed twice before the APP-BUG-5 fix, which does not touch it) | 2.0 min each |
| any | Firefox (Playwright's Firefox 1511) | **does not launch on this macOS machine** (Darwin 27), as in every phase. Not run | n/a |

Q2 runs on a `next dev` server, so React is the development build; a production build does less work per render, and the
long-task margins below are a dev-mode measurement.

What each one observed (after the fixes below):

- **Q2** 300 PNGs of 200 KB, signed in as `secondary` (whose panel has few earlier uploads, and to keep off primary's share of
  the read limit), the uploads panel open before the drop. Chromium: all 300 uploaded in 18.6 to 18.7 s and Ready in 24.4 to
  26.5 s; at most 3 rows Starting or Uploading at any 1 s sample; none failed, was interrupted or cancelled; each file
  created once and the project holds 300 assets. **9 to 10 long tasks over 50 ms in the whole run, the longest 82 to 84 ms**
  (bound 200 ms). The page's reads of the API: 368 to 390 in the run (limit 600 a minute), no request refused; the grid read
  the project's assets 13 to 14 times and its last read returned all 300. WebKit: all 300 uploaded in 22.2 to 29.3 s, Ready
  in 25.9 to 35.8 s, 185 to 272 reads, nothing refused.
- **S3** five 1 MB PNGs, parts on hold: three Uploading, two Queued. `docker stop` of the MinIO, the held parts released into
  the outage, 60 s, `docker start`. Through the 60 s: the three sending rows stayed Uploading (their part retry ladder), the
  two queued stayed "Waiting to start", no row failed, no part was answered, no queued file was created. After the start, in
  all three runs, **all three sending files recovered** (none ended Interrupted) and the two queued uploaded, everything
  settled 1.2 to 2.4 s after storage was back; no `/upload/abort` was sent. **Fix round 1** added a Cancel of the first
  sending file 15 s into the outage, so that a queued file's turn comes under `docker stop` too: the fourth file asked at
  once, was answered 503 `storage_unavailable` (ten times, about 5 s apart, through the rest of the outage), read "Waiting
  for storage" and held; the fifth never asked; after the start the fourth was created once and everything but the cancelled
  file uploaded (the two still sending recovered), with the cancel's abort the only one sent.
- **S4** (`docker network disconnect`, the row's mechanism) and **S4b** (`docker pause`): the same frozen queue, storage cut,
  then the first sending file is cancelled, so the fourth file's turn comes. Its initiate is sent at once, answered with the
  coded 503 `storage_unavailable`, and the row reads **"Waiting for storage" 10.1 to 10.2 s after its turn** in all six runs
  (bound 20 s). For 10 s more nothing fails and the fifth file waits its turn. With storage back and the parts released,
  the four that were not cancelled upload, the fourth created once.

What each outage looks like from each side (measured with `curl` against the stack, Docker Desktop for Mac, 2026-10-23):

| Outage | Browser to the host port (19000) | API `POST /upload/initiate` |
|---|---|---|
| `docker stop` | refused at once | 503 `storage_unavailable` in 0.01 s |
| `docker network disconnect` | the connection is accepted, then no answer (15 s and counting) | 503 in 0.09 s from a cold API (the name no longer resolves); 10 s when its S3 client has a connection open already, as in S4 |
| `docker pause` | the connection is accepted, then no answer | 503 after the initiate client's 10 s read timeout (10.04 s) |

So `network disconnect` does black-hole the browser's side (it does not refuse), and `pause` black-holes both sides; S4 runs
with each. Reconnecting must give the container back its compose alias (`minio`), which a plain `docker network connect`
does not: `restoreStorage` reads the network and the alias from the container's compose labels, so a run killed mid-outage
is put back by the next one's `beforeEach`.

**APP-BUG-3 (fixed, `4a588d3a`): a large drop spent the account's read limit.** Every status move of every upload (three per
file) refetched the project grid at once, two GETs each. The first Q2 runs read the API 2 222 times in 24 s (1 072
`/projects/:id/assets`, 1 051 `/projects/:id/folders`), and a second 3 372 times, of which 2 796 were refused: a 429 carries
no CORS header, so Chromium reports it as `net::ERR_FAILED`. The grid kept retrying into the limit until +59 s, when the
minute ran out and its last read returned all 300; the test's own read of the project afterwards was refused with 429. Every
other read of that account, in any tab, fails the same way for that minute. The refetch now runs at most once per 2 s (the
first change after a quiet spell at once, the rest folded into one at the end of the gap). Unit tests in
`hooks/__tests__/use-upload-refetch.test.tsx`; with the gap removed the 300-file test sees 898 refetches against a bound of 14.

**APP-BUG-4 (fixed, `99164645`): every status move re-rendered the whole project page.** The same hook read the store through
selectors, so each move re-rendered its caller, the project page, with every asset card in the grid. With only APP-BUG-3
fixed, Q2 in Chromium had 276 to 298 long tasks over 50 ms, the longest 198 to 270 ms (one run failed the bound with 209, 206
and 201 ms, the next passed at 198 ms), and the 300 files took 48 to 57 s to upload instead of 19 s. A 15 s CPU profile
mid-drop had the main thread idle for 0.25 s and React's synchronous rendering for 10.3 s (`AssetCard` and its context-menu
wrappers among the busiest). The hook now watches the store with a subscription and never re-renders the page. Q2's 200 ms
bound caught this only marginally (1 run of 2); the unit test "does not re-render the caller when uploads change status
either" pins it (61 renders before the fix, 1 after).

**APP-BUG-5 (fixed, `acb82ae7`): a cancelled upload kept its place until `/upload/abort` answered.** The run awaited the abort
before giving its place back, and with storage unreachable the API takes its S3 client's whole retry budget to answer: 10.5 s
with MinIO unplugged and 310.6 s with it paused (measured with `curl`). Before the fix S4 failed in both forms: unplugged, the
next file's initiate went out 65.2 s after the Cancel and "Waiting for storage" showed at 75.4 s; paused, the next file had
not started 120 s later. The abort is now sent and not awaited. Unit test in `stores/__tests__/upload-queue-cancel.test.ts`
("a cancelled upload gives its place to the next file at once ..."), which fails without the fix. C1, C2, C3, R3, Q3, V1 and
the smoke test were re-run on Chromium and WebKit after these fixes: 14 of 14 passed.

Observations, not fixed here (outside the upload queue; each pre-dates it on `main`):

- **The processing poll reads once per processing row every 5 s.** `refreshProcessingItems` (driven by
  `components/layout/upload-sse-bridge.tsx`) sends one `GET /assets/:id` per row in Processing, so it costs 12 reads a minute
  per row: 340 to 360 of Q2's 390 reads in Chromium, where PNGs are Ready within seconds. Fifty rows that stay in Processing
  (video, which transcodes for minutes) reach the 600-a-minute limit on their own. A batched read, or one per project, would
  bound it.
- **`POST /upload/abort` uses the API's default S3 client** (boto3's 60 s read timeout, retried), so with storage hanging one
  abort holds its request and a worker thread for about 310 s before answering 503. Initiate (10 s, one attempt) and the
  probes (3 s / 5 s) already have bounded clients.
- Right after storage came back once (S4b's setup, straight after S4 restored the network), the API answered two initiates
  503 `storage_unavailable`; the queue held them and they went through 5 s later, as designed.

### Phase 6 gate, fix round 1 (2026-10-23)

The test plan's step 2 in full, after fix round 1 (storage restored first in `afterEach`, the infra helpers refuse anything but
the `minio` service of an `ffe2e` compose project, the cancel order pinned by a unit test, S3 cancelling a sending file
mid-outage). Each run had its own `--output` directory under `/tmp`, deleted afterwards.

| Run | Result | Duration |
|---|---|---|
| `pnpm test:chromium` (whole suite, `E2E_INFRA` unset) | 57 passed, 5 skipped (the two setup sign-ins, saved sessions reused, and the three infra tests); the `test.fail()` fixtures test is drawn as a cross and counts as passed | 13.1 min |
| `pnpm test:webkit` (whole suite, started 70 s after) | 57 passed, 5 skipped, the same | 14.9 min |
| `E2E_INFRA=1 pnpm test:chromium -- tests/infra.spec.ts` | 3 passed (S3, S4, S4b), 2 skipped (setup); and once more just before the whole suites, 3 passed | 2.0 min each |
| Firefox | does not launch on this Mac, as before; not run | n/a |

Nothing failed and nothing was re-run. Q2 inside the whole suites: Chromium uploaded 300 in 15.2 s, Ready in 22.0 s, 8 long
tasks over 50 ms, the longest 79 ms, 321 reads, none refused; WebKit uploaded 300 in 19.4 s, Ready in 21.6 s, 138 reads, none
refused. S3 in both infra runs: the fourth file held "Waiting for storage" (503 about every 5 s), the two still sending
recovered, settled 2.4 to 4.8 s after the start. S4 and S4b: "Waiting for storage" 10.1 to 10.2 s after the next file's turn.
The suite now has 57 tests per engine where Phase 5 had 55: Q2, and the `storageContainer()` refusal check in
`fixtures.spec.ts`; the three infra tests are skipped without `E2E_INFRA=1`. Web unit suite 149 files, 1 503 tests; `tsc
--noEmit` clean; lint 18 warnings, 0 errors.

### Mutation and failure checks

- Q2 fails on the app before APP-BUG-3's fix (the 429s above) and, marginally, before APP-BUG-4's (1 run of 2).
- S4 and S4b fail on the app before APP-BUG-5's fix (the timings above).
- S3 has no mutation of its own. Since fix round 1 it also cancels a sending file mid-outage, so the fourth file's turn
  comes under `docker stop` and its hold ("Waiting for storage", no row failed, created once afterwards) is checked there
  as well as in S4.

## Phase 6 live Chrome results (the final pass)

Run by hand in real, headed Chrome 154.0.8037.100 on top of the whole stack (`f3e0d9aa`, `feat/upload-queue-6-polish`),
2026-10-23, with a fix round the same day: [`live-runs/2026-10-23-final.md`](live-runs/2026-10-23-final.md).

- **Run and passed**: every matrix row from Q1 to P2, plus U3's two sub-cases (U3b, a part that stalls after progress, against the
  stall server; U3c, the two 5 min clocks), L1's tab close and negative, L2's one-file variant and negative, and L3b (the refresh
  refused). The "Live Chrome run" column above links each row.
- **Not run here**: row M (real Safari, real Firefox), owed to the user; and the checks that have no matrix row (phase 2's E1 to E3,
  phase 3's X1 to X3, phase 4's T1 to T3, phase 5's W1 to W4 and V).
- How: the DevTools MCP's profile was held by a Chrome the pass had not started, so the pass drove headed Chromes of its own over the
  DevTools protocol (`LIVE-CHROME.md` section 10), with the driver's new `trace`, `metrics`, `screencast` and `filesraw` standing in for the MCP's
  trace, memory, GIF and file tools.
- **Q1/Q3 wire concurrency**: the first run's `lsof` samples mixed two Chromes and are not evidence. Re-sampled per process in the fix
  round: 9 storage sockets while throttled with 3 PUTs pending (the other 6 are the grid's thumbnail loads, a connection group of their
  own), 11 just after the lift and then idle keep-alive. The verdicts rest on the probe's row samples and in-flight peaks.
- **Q2 with a performance trace**: 300 uploaded in 19.2 s, Ready in 24.0 s; worst main-thread task 88 ms (trace) and 86 ms
  (PerformanceObserver), none over 100 ms in the trace; `requestAnimationFrame` intervals p50 8.4 ms, p95 17.1 ms, max 116.8 ms on a
  120 Hz display (the trace's own frame events time the whole pipeline over a longer window; the trace was deleted for holding a token).
- **500 files at Fast 3G for 30 minutes** (secondary, panel open): all 500 Ready, the last completion at 29.6 min; two token expiries
  handled; worst long task 125 ms. 350 were complete at 16.6 min and 500 at 29.6 min: the second half ran at half the rate, for a
  reason not measured. Heap after a forced GC 19.6 MB before the drop, 63.8 MB at 16.6 min, 67.1 MB at 30.2 min: no unbounded growth over
  the 13.6 min measured (+3.3 MB between 350 and 500 complete). That is not a leak test.
- **A 1.45 GB, 180 s 1080p video**: uploaded in 20 s (139 parts), transcoded in 323 s, Ready, and it plays at 1920 x 1080 with no
  dropped frames; the worker ran 317 tasks in that window, all succeeded.
- GIFs of Q1, U2, A1 and L2 are attached to the pull request.
- **No app bug of the upload queue was found.** Observations (in the report): a video run needs free storage, and a trash does not
  give it back; and the main thread is busy (about 89% in Q2, 48% in the long run, mostly paint at 120 Hz
  in a development build) without breaking any bound. Outside the feature, pre-existing: the floating "Powered by FreeFrame" badge
  covers the project page's "Open in viewer to comment" link; a signed-out Notifications click raises an uncaught `ApiError` (phase 4);
  a drop on a project page before the account's role has loaded is ignored, silently (phase 5).

## Manual pass owed (real Safari, real Firefox)

**Not one manual result has been recorded yet.** As of this commit every cell of the matrix's "Real Safari" and "Real
Firefox" columns is empty (`—`): 29 rows, 58 cells, for every phase from 2 to 6. The passes in this file were run by
Playwright (Chromium headless shell and Playwright's WebKit) and by hand in real Chrome; none of them is a real Safari or a
real Firefox, and Playwright's Firefox does not launch on the Mac this was written on. The pass below is owed before the
phase PRs merge. Record each result with the browser version, here and in the matrix row's two cells.

Fill in once per pass: Safari version `____`, Firefox version `____`, macOS version `____`, branch and commit `____`, date `____`.

| Item | Phase | What to do by hand | Real Safari | Real Firefox |
|---|---|---|---|---|
| Q1 | 2 | 50 mixed files, network throttled (Firefox: DevTools throttling; Safari: Network Link Conditioner); never more than 3 moving, drop order | — | — |
| Q2 | 6 | 300 files of 200 KB with the panel open; all Ready, the page stays responsive (scroll the panel and the grid while it runs), the grid ends with 300 | — | — |
| Q3 | 2 | two drops 2 s apart; the second's files start after the first's | — | — |
| Q4 | 2 | rename a queued file; the asset gets the new name | — | — |
| C1 | 2 | Cancel a queued file; the row goes, nothing sent for it | — | — |
| C2 | 2 | "Cancel all queued" mid-run; active files go on | — | — |
| C3 | 2 | Cancel the active file; the next starts | — | — |
| U1 | 3 | `touch` a queued file before its turn; the changed-file copy, Dismiss only | — | — |
| U2 | 3 | `rm` the sending file; Interrupted with the same copy, the queue goes on | — | — |
| U3 | 3 | a part that stops (e.g. a proxy that stops reading); the part is retried, the queue does not freeze | — | — |
| N1 | 3 | wifi off at the drop, on after 30 s; "Waiting for connection", none fails, all upload | — | — |
| N2 | 3 | wifi off mid-part for 20 s; the sending files recover | — | — |
| S1 | 2 | storage refusing initiates (`docker stop` of the e2e MinIO for 15 s at the drop); "Waiting for storage", then on | — | — |
| S2 | 2 | part PUTs failing for 60 s; the queue does not storm (DevTools network panel) | — | — |
| S3 | 6 | `docker stop ffe2e-minio-1` mid-queue, `docker start ffe2e-minio-1` 60 s later; queued files hold, sending ones recover or end Interrupted | — | — |
| S4 | 6 | `docker network disconnect ffe2e_default ffe2e-minio-1`, cancel a sending file; "Waiting for storage" within 20 s; restore with `docker network connect --alias minio --alias ffe2e-minio-1 ffe2e_default ffe2e-minio-1` | — | — |
| R1 | 2 | close the tab mid-upload, reopen, Resume while 10 files are queued; it goes next | — | — |
| R2 | 4 | two tabs Resume the same row at once; one sends, the other shows Elsewhere | — | — |
| R3 | 2 | Cancel during Resuming; back to Interrupted, no abort | — | — |
| A1 | 4 | log out in tab B with files queued in tab A | — | — |
| A2 | 4 | accept an invite in another window while A sends | — | — |
| A3 | 4 | sign in as another account after primary left interrupted rows | — | — |
| L1 | 5 | Reload with files queued: **the prompt seen on screen** (Stay keeps the page; Leave reloads). Unmeasured in Firefox by any engine so far | — | — |
| L2 | 5 | Log out with files queued; the in-app confirm, then no browser prompt | — | — |
| L3 | 5 | clear both tokens, then a request; to /login, no prompt | — | — |
| V1 | 2 | New Version during a long queue | — | — |
| P1 | 2 | a storage cap that fits about 3 of 10 files | — | — |
| P2 | 2 | delete the project under 5 queued files | — | — |
| M | every | hard reload, then drop from Finder **without clicking the page**, then reload (the leave prompt needs a user interaction first) | — | — |
| W4 | 5 | wake lock in a **truly hidden** tab: another tab signs out and back in while this one uploads in the background; record whether a lock is held and when it is re-taken (`pmset -g assertions` shows the browser's assertion) | — | — |
| Idle timer | 5 | during a long "Waiting for storage" hold with the display idle, do the short lock pulses on each retry keep the Mac awake? `pmset -g assertionslog` while it holds | — | — |
| Laptop sleep | 3 | close the lid mid-upload for a minute, open it; the rows recover or end Interrupted, none lost (by a person, not an automated run) | — | — |

Q2 and S3/S4 are on the list though they are Chromium-only in the matrix's Engines column, because the test plan for this phase
asks for them by hand as well. S3 and S4 need the e2e stack (`-p ffe2e`) and must be put back afterwards
(`docker start`, or `docker network connect` with the alias as above, then `curl http://localhost:19000/minio/health/live`).

## Already covered

Phase 0 adds no scenario rows of its own. The existing specs cover groundwork the rows above
stand on:

- `tests/smoke.spec.ts`: signs in through the real login form, creates a project, drops a 3 MB
  PNG, and checks that it becomes one asset.
- `tests/fixtures.spec.ts`: checks that each fault and file helper (throttle, `failInitiate`,
  `failParts`, `hangParts`, `countRequests`, `touch`, `remove`) has its observable effect, so a
  scenario cannot pass on a fixture that silently does nothing.
