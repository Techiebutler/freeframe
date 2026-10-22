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
| Q1 | Drop 50 mixed files (1 KB–40 MB, ~300 MB total), throttled to 2 MB/s, `test.setTimeout(30 min)` | at every 500 ms sample, rows in Starting, Resuming or Uploading (including finalizing) ≤ 3; start order = drop order; the next file starts only near the end of the one ahead | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#q1-drop-50-mixed-files-pass) | — | — |
| Q2 | Drop 300 files of 200 KB with the panel open | all complete; no main-thread long task > 200 ms during the run (PerformanceObserver `longtask`, Chromium only) | Chromium | 6 | — | — | — | — |
| Q3 | Two drops 2 s apart | the second drop's files start after the first drop's | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#q3-two-drops-2-s-apart-pass) | — | — |
| Q4 | Rename a queued file | the asset is created with the new name | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#q4-rename-a-queued-file-pass) | — | — |
| C1 | Cancel a queued file | the row disappears; no initiate for it (`countRequests`) | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#c1-cancel-a-queued-file-pass) | — | — |
| C2 | "Cancel all queued" mid-run | active files continue; every queued row disappears | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#c2-cancel-all-queued-mid-run-pass) | — | — |
| C3 | Cancel the active file | the next file starts; `/upload/abort` sent once | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#c3-cancel-the-active-file-pass) | — | — |
| U1 | `touch` a queued file before its turn | that row: "The file changed or was moved after it was added. Add it again.", Dismiss only (no Retry); no initiate for it; the queue continues | Chromium, WebKit, Firefox | 3 | `tests/unreadable.spec.ts` | [PASS](live-runs/2026-10-22-phase-3.md#u1-touch-a-queued-file-before-its-turn-pass) | — | — |
| U2 | `remove` the sending file mid-part | the row ends Interrupted with the same copy within 90 s + backoff (Chromium errors the send at once; in WebKit the send hangs with no event and the part watchdog ends it); nothing is aborted; the queue continues | Chromium, WebKit, Firefox | 3 | `tests/unreadable.spec.ts` | [PASS](live-runs/2026-10-22-phase-3.md#u2-rm-the-sending-file-mid-part-pass) | — | — |
| U3 | `hangParts` / `stallParts` for parts of a file | the part watchdog aborts a part and retries it, and the queue does not freeze. A part that has sent its first byte and then stops is aborted after 90 s without upload progress. A part that has not sent a byte yet is aborted only when the whole tab has had no upload progress for 90 s, or when it has itself waited 5 min (the hard cap, so a part held behind busy sockets is not mistaken for a stalled one). A part that sent its last byte waits 5 min for the answer. The retry goes through; the 5 min cap alone is not automated (see Phase 3 results) | Chromium, WebKit, Firefox | 3 | `tests/unreadable.spec.ts` (U3: parts that never start, tab silent; U3b: a part that stops after progress, tab busy) | [PASS](live-runs/2026-10-22-phase-3.md#u3-parts-that-never-start-tab-silent-pass-stand-in-parts-held-nothing-sent), and [U3b](live-runs/2026-10-22-phase-3.md#u3b-a-part-that-stops-after-progress-tab-busy-pass-real-socket-stall-server) and [the two 5 min clocks](live-runs/2026-10-22-phase-3.md#u3c-the-two-5-min-clocks-u3s-text-the-5-min-cap-alone-is-not-automated-pass-real-sockets), run live | — | — |
| N1 | `context.setOffline(true)` at enqueue, back online after 30 s | rows show "Waiting for connection"; none failed; all complete after reconnect (WebKit: `networkSwitch` aborts the API and bucket requests instead, see Phase 3 results) | Chromium, WebKit, Firefox | 3 | `tests/network.spec.ts` | [PASS](live-runs/2026-10-22-phase-3.md#n1-offline-at-enqueue-pass) | — | — |
| N2 | Offline mid-part for 20 s | the sending file's ladder recovers; queued files never fail | Chromium, WebKit, Firefox | 3 | `tests/network.spec.ts` | [PASS](live-runs/2026-10-22-phase-3.md#n2-offline-mid-part-pass) | — | — |
| S1 | `failInitiate` coded 503 three times | "Waiting for storage", then the queue continues; 3 retries spaced ≥ 5 s | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#s1-failinitiate-coded-503-pass-with-the-real-fault) | — | — |
| S2 | `failParts(503)` on every PUT for 60 s | presign requests ≤ budget × 8 over the window (`countRequests`) | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#s2-failparts503-for-60-s-pass-stand-in-network-errors) | — | — |
| S3 | Infra: `docker stop` storage mid-queue, start after 60 s | queued files hold; the sending file ends Interrupted (as today) or recovers | Chromium | 6 | — | — | — | — |
| S4 | Infra: black-hole storage (`docker network disconnect`) | "Waiting for storage" within 20 s of the next file's turn | Chromium | 6 | — | — | — | — |
| R1 | Interrupt an upload (close the page), reopen, Resume while 10 files are queued | the Resume starts next; its `ff-uploads` entry exists throughout | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` (R1, and R1b, the APP-BUG-1 regression test, fixed 2026-10-22) | [PASS after the fix, 2026-10-22](live-runs/2026-10-22-phase-2.md#r1-re-run-after-app-bug-1-fix-pass) (first run: [FAIL, APP-BUG-1](live-runs/2026-10-22-phase-2.md#r1-interrupt-reopen-resume-while-files-are-queued-fail-app-bug-1)) | — | — |
| R2 | Two tabs, Resume the same interrupted row in both | exactly one tab presigns | Chromium, WebKit, Firefox | 4 | — | — | — | — |
| R3 | Cancel during Resuming | the row returns to Interrupted; no `/upload/abort` | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#r3-cancel-during-resuming-pass) | — | — |
| A1 | Two pages, one context: log out in B with files queued in A | A redirects to /login; after signing back in, A's queued files show as Failed with the signed-out message | Chromium, WebKit, Firefox | 4 | — | — | — | — |
| A2 | Accept an invite as `secondary` in tab B while A sends | A's sending row ends Interrupted; A's queued rows fail with the account message; no asset lands in `secondary`'s account | Chromium, WebKit, Firefox | 4 | — | — | — | — |
| A3 | Sign in as `secondary` in the same browser after `primary` left interrupted rows | `secondary` sees none of them; `primary` sees them again after switching back | Chromium, WebKit, Firefox | 4 | — | — | — | — |
| L1 | Reload with files queued | the beforeunload dialog appears (`page.on('dialog')`, type `beforeunload`) in Chromium and WebKit | Chromium, WebKit, Firefox | 5 | — | — | — | — |
| L2 | Log out with files queued | in-app confirm "N uploads will stop. Log out anyway?"; confirming navigates with no beforeunload dialog | Chromium, WebKit, Firefox | 5 | — | — | — | — |
| L3 | Expired session (clear both tokens, then trigger a request) | redirect to /login, no dialog | Chromium, WebKit, Firefox | 5 | — | — | — | — |
| V1 | New Version during a long queue | the asset page shows "New version queued, waiting for other uploads."; the version appears without reload | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#v1-new-version-during-a-long-queue-pass) | — | — |
| P1 | A storage cap that fits only about 3 of 10 files | at least one row Failed "Storage limit reached …" with Retry; every row ends Complete/Processing or Failed; none stays Queued or Starting; committed bytes exceed the cap by at most one file (with at most two files in flight; the cap counts only committed media) | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#p1-storage-cap-pass) | — | — |
| P2 | Project deleted while 5 files are queued for it, plus 2 queued for another project | the 5 fail with 404; the 2 upload | Chromium, WebKit, Firefox | 2 | `tests/queue.spec.ts` | [PASS](live-runs/2026-10-22-phase-2.md#p2-project-deleted-under-queued-files-pass) | — | — |
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
  R3, V1, P1 (0.5 file over the cap), P2. Plus the brief's exploratory checks: 50 files at Slow 3G (one initiate at a time, three files sending),
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

- **Passing**: U1, U2, U3, N1, N2, plus the checks the brief asked for and two the live pass added: U3b (a part that sent 1.08 MB and
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
- **Laptop sleep: moved to the manual pass** (controller ruling R9: the machine is not put to sleep in an automated run).
- "Touch a file in a synced folder" used a plain local folder: the Google Drive, OneDrive and iCloud folders on the machine are the
  user's, not test locations.
- Not run here: the manual real Safari and real Firefox pass (matrix row M).

## Already covered

Phase 0 adds no scenario rows of its own. The existing specs cover groundwork the rows above
stand on:

- `tests/smoke.spec.ts`: signs in through the real login form, creates a project, drops a 3 MB
  PNG, and checks that it becomes one asset.
- `tests/fixtures.spec.ts`: checks that each fault and file helper (throttle, `failInitiate`,
  `failParts`, `hangParts`, `countRequests`, `touch`, `remove`) has its observable effect, so a
  scenario cannot pass on a fixture that silently does nothing.
