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
| Q1 | Drop 50 mixed files (1 KB–40 MB, ~300 MB total), throttled to 2 MB/s, `test.setTimeout(30 min)` | at every 500 ms sample, rows in Starting, Resuming or Uploading (including finalizing) ≤ 3; start order = drop order; the next file starts only near the end of the one ahead | Chromium, WebKit, Firefox | 2 | — | — | — | — |
| Q2 | Drop 300 files of 200 KB with the panel open | all complete; no main-thread long task > 200 ms during the run (PerformanceObserver `longtask`, Chromium only) | Chromium | 6 | — | — | — | — |
| Q3 | Two drops 2 s apart | the second drop's files start after the first drop's | Chromium, WebKit, Firefox | 2 | — | — | — | — |
| Q4 | Rename a queued file | the asset is created with the new name | Chromium, WebKit, Firefox | 2 | — | — | — | — |
| C1 | Cancel a queued file | the row disappears; no initiate for it (`countRequests`) | Chromium, WebKit, Firefox | 2 | — | — | — | — |
| C2 | "Cancel all queued" mid-run | active files continue; every queued row disappears | Chromium, WebKit, Firefox | 2 | — | — | — | — |
| C3 | Cancel the active file | the next file starts; `/upload/abort` sent once | Chromium, WebKit, Firefox | 2 | — | — | — | — |
| U1 | `touch` a queued file before its turn | that row: "The file changed or was moved after it was added. Add it again.", Dismiss only; no initiate; the queue continues | Chromium, WebKit, Firefox | 3 | — | — | — | — |
| U2 | `remove` the sending file mid-part | the row ends Interrupted within 90 s + backoff; the queue continues; in WebKit the hang is broken by the watchdog | Chromium, WebKit, Firefox | 3 | — | — | — | — |
| U3 | `hangParts` for one file | parts are aborted after 90 s and retried; the queue does not freeze | Chromium, WebKit, Firefox | 3 | — | — | — | — |
| N1 | `context.setOffline(true)` at enqueue, back online after 30 s | rows show "Waiting for connection"; none failed; all complete after reconnect | Chromium, WebKit, Firefox | 3 | — | — | — | — |
| N2 | Offline mid-part for 20 s | the sending file's ladder recovers; queued files never fail | Chromium, WebKit, Firefox | 3 | — | — | — | — |
| S1 | `failInitiate` coded 503 three times | "Waiting for storage", then the queue continues; 3 retries spaced ≥ 5 s | Chromium, WebKit, Firefox | 2 | — | — | — | — |
| S2 | `failParts(503)` on every PUT for 60 s | presign requests ≤ budget × 8 over the window (`countRequests`) | Chromium, WebKit, Firefox | 2 | — | — | — | — |
| S3 | Infra: `docker stop` storage mid-queue, start after 60 s | queued files hold; the sending file ends Interrupted (as today) or recovers | Chromium | 6 | — | — | — | — |
| S4 | Infra: black-hole storage (`docker network disconnect`) | "Waiting for storage" within 20 s of the next file's turn | Chromium | 6 | — | — | — | — |
| R1 | Interrupt an upload (close the page), reopen, Resume while 10 files are queued | the Resume starts next; its `ff-uploads` entry exists throughout | Chromium, WebKit, Firefox | 2 | — | — | — | — |
| R2 | Two tabs, Resume the same interrupted row in both | exactly one tab presigns | Chromium, WebKit, Firefox | 4 | — | — | — | — |
| R3 | Cancel during Resuming | the row returns to Interrupted; no `/upload/abort` | Chromium, WebKit, Firefox | 2 | — | — | — | — |
| A1 | Two pages, one context: log out in B with files queued in A | A redirects to /login; after signing back in, A's queued files show as Failed with the signed-out message | Chromium, WebKit, Firefox | 4 | — | — | — | — |
| A2 | Accept an invite as `secondary` in tab B while A sends | A's sending row ends Interrupted; A's queued rows fail with the account message; no asset lands in `secondary`'s account | Chromium, WebKit, Firefox | 4 | — | — | — | — |
| A3 | Sign in as `secondary` in the same browser after `primary` left interrupted rows | `secondary` sees none of them; `primary` sees them again after switching back | Chromium, WebKit, Firefox | 4 | — | — | — | — |
| L1 | Reload with files queued | the beforeunload dialog appears (`page.on('dialog')`, type `beforeunload`) in Chromium and WebKit | Chromium, WebKit, Firefox | 5 | — | — | — | — |
| L2 | Log out with files queued | in-app confirm "N uploads will stop. Log out anyway?"; confirming navigates with no beforeunload dialog | Chromium, WebKit, Firefox | 5 | — | — | — | — |
| L3 | Expired session (clear both tokens, then trigger a request) | redirect to /login, no dialog | Chromium, WebKit, Firefox | 5 | — | — | — | — |
| V1 | New Version during a long queue | the asset page shows "New version queued, waiting for other uploads."; the version appears without reload | Chromium, WebKit, Firefox | 2 | — | — | — | — |
| P1 | A storage cap that fits only about 3 of 10 files | at least one row Failed "Storage limit reached …" with Retry; every row ends Complete/Processing or Failed; none stays Queued or Starting; committed bytes exceed the cap by at most one file (the cap counts only committed media) | Chromium, WebKit, Firefox | 2 | — | — | — | — |
| P2 | Project deleted while 5 files are queued for it, plus 2 queued for another project | the 5 fail with 404; the 2 upload | Chromium, WebKit, Firefox | 2 | — | — | — | — |
| M | Manual, **real Safari and real Firefox**, every phase: the phase's scenarios from this table, plus "hard reload, then drop from Finder without clicking, then reload". By the end, every scenario above has a real Safari and a real Firefox result | record the result in `SCENARIOS.md` with browser versions, before that phase's PR merges | Safari, Firefox (manual) | every phase | — | — | — | — |

## Already covered

Phase 0 adds no scenario rows of its own. The existing specs cover groundwork the rows above
stand on:

- `tests/smoke.spec.ts`: signs in through the real login form, creates a project, drops a 3 MB
  PNG, and checks that it becomes one asset.
- `tests/fixtures.spec.ts`: checks that each fault and file helper (throttle, `failInitiate`,
  `failParts`, `hangParts`, `countRequests`, `touch`, `remove`) has its observable effect, so a
  scenario cannot pass on a fixture that silently does nothing.
