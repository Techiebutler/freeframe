# FreeFrame end-to-end tests

Real-browser tests ([Playwright](https://playwright.dev)) for the web app, driven against a
running dev stack. They exist for what unit tests cannot see: files read from disk by a real
browser, uploads that outlive a page, two tabs sharing one `localStorage`, an S3 endpoint
that misbehaves.

For the hands-on pass in a real, headed Chrome driven through DevTools (not run by `pnpm test`),
see [`LIVE-CHROME.md`](LIVE-CHROME.md); its results are in `live-runs/` and the scripts it loads into the page are in `live-tools/`.

This is a standalone package with its own `package.json` and lockfile. Nothing in `apps/web`
depends on it, and `pnpm install` at the repo root does not touch it.

## 1. Start the stack

```bash
cp .env.example .env
docker compose -f docker-compose.dev.yml up --build
```

The tests expect the stack on its default ports, so **3000, 8000, 9000, 5433 and 6379 must be
free**: stop any other stack using them first.

### Or: run it beside another stack, on other ports

If those ports are taken and you cannot stop what holds them, run this stack as its own compose
project on remapped ports. Keep the override and the env file **outside the repo** (they are
local, never committed). With `$DIR` as a folder of your choosing:

```yaml
# $DIR/docker-compose.e2e.override.yml
services:
  postgres: { ports: !override ["15433:5432"] }
  redis:    { ports: !override ["16379:6379"] }
  minio:    { ports: !override ["19000:9000", "19001:9001"] }
  api:
    ports: !override ["18000:8000"]
    env_file: !override [$DIR/.env]       # absolute path
  worker:             { env_file: !override [$DIR/.env] }
  email_worker:       { env_file: !override [$DIR/.env] }
  maintenance_worker: { env_file: !override [$DIR/.env] }
  beat:               { env_file: !override [$DIR/.env] }
  web:
    ports: !override ["13000:3000"]
```

```bash
# $DIR/.env: the public URLs have to follow the new ports. The browser talks to the API and to
# S3 directly, and the bucket's CORS rules are written from FRONTEND_URL and CORS_ALLOW_ORIGINS.
JWT_SECRET=any-long-random-string
FRONTEND_URL=http://localhost:13000
NEXT_PUBLIC_API_URL=http://localhost:18000
S3_PUBLIC_ENDPOINT=http://localhost:19000
CORS_ALLOW_ORIGINS=http://localhost:13000,http://127.0.0.1:13000
STALE_UPLOAD_TIMEOUT_HOURS=0    # keep the reaper and the retention GC away from test data
SOFT_DELETE_RETENTION_DAYS=0
```

```bash
docker compose -p ffe2e --env-file $DIR/.env \
  -f docker-compose.dev.yml -f $DIR/docker-compose.e2e.override.yml up -d --build

# stop it (keeps the data), or throw the data away too:
docker compose -p ffe2e --env-file $DIR/.env \
  -f docker-compose.dev.yml -f $DIR/docker-compose.e2e.override.yml stop
docker compose -p ffe2e --env-file $DIR/.env \
  -f docker-compose.dev.yml -f $DIR/docker-compose.e2e.override.yml down -v
```

`-p ffe2e` gives the containers, network and volumes their own names, so nothing of another
stack is touched. Then point the tests at it:

```bash
E2E_BASE_URL=http://localhost:13000 E2E_API_URL=http://localhost:18000 pnpm test
```

> If the `web` container exits at start with `npm error Cannot read properties of null (reading
> 'edgesOut')`, the stock `npm install && next dev` command is hitting an npm 10 crash on a
> fresh `node_modules` volume. Give `web` a `command: !override` that first runs
> `npm install -g npm@11.19.0`.

## 2. Install and run

```bash
cd e2e
pnpm install
pnpm exec playwright install chromium webkit firefox

pnpm test                                   # every project
pnpm test:chromium                          # one engine
pnpm test:webkit -- tests/smoke.spec.ts     # one file
```

**Check the disk before a run.** Uploaded objects stay in the stack's MinIO (about 0.5 to 1 GB per full run), and the
Docker VM's disk is shared with everything else on the machine. At about 99% full MinIO answers part PUTs with 507 and
every scenario that completes an upload stalls in the retry ladder. Run
`docker exec ffe2e-minio-1 df -h /data` first (the container of the `-p ffe2e` stack; use the name of yours) and clear the
bucket past about 90%: either empty this stack's objects
(`docker exec ffe2e-minio-1 sh -c 'rm -rf /data/freeframe/raw/* /data/freeframe/processed/*'`, objects of this stack only; the
database rows that point at them go stale and nothing reads them) or recreate the stack (`down -v`, then `up -d --build`; the
accounts and sessions are recreated by `accounts.ts`).

`workers` is 1 and `retries` is 0 on purpose: the scenarios share one backend and a retry that
passes would hide the races they exist to catch. A failure keeps a trace:
`pnpm exec playwright show-trace test-results/<test>/trace.zip`.

## Environment variables

| Variable                | Default                 | Meaning |
| ----------------------- | ----------------------- | ------- |
| `E2E_BASE_URL`          | `http://localhost:3000` | The web app. |
| `E2E_API_URL`           | `http://localhost:8000` | The API, for accounts and projects made without the UI. |
| `E2E_PRIMARY_EMAIL`     | unset                   | Only for a stack that already has a superadmin and no `.accounts.json`: an existing superadmin to use as `primary`. |
| `E2E_PRIMARY_PASSWORD`  | unset                   | Its password. |
| `E2E_FORCE_LOGIN`       | unset                   | Set to `1` to sign both accounts in through the form even if their saved sessions still work. |
| `E2E_UPLOAD_CONCURRENCY` | `5`                    | The part budget of the stack under test (its `NEXT_PUBLIC_UPLOAD_CONCURRENCY`). `queue.spec.ts` uses it for the start-rule check (Q1) and the presign bound (S2); set it when the stack's value is not 5. |

## How it works

**Accounts.** `fixtures/accounts.ts` creates two users once and caches them in
`e2e/.accounts.json`: `primary` is the first-run superadmin (`POST /setup/create-superadmin`),
`secondary` an ordinary member invited by it. If the database is wiped (the instance reports
`needs_setup` again) the cache is dropped and both are recreated.

**Sessions.** Two things sign in, for two different reasons.

- The `setup` project (`tests/auth.setup.ts`) signs each account in through the login form and
  saves the session to `e2e/.auth/<account>.json`. Every other test calls `signIn(page, account)`,
  which loads that file, so a suite of any size makes no `/auth/login` calls of its own. A
  session whose refresh token still works is kept, and its setup test is reported as **skipped**,
  not passed. Every browser project depends on `setup`, which always runs in Chromium; a saved
  session is plain cookies and localStorage and loads in any engine. `E2E_FORCE_LOGIN=1` signs
  in again regardless.
- The smoke scenario (`tests/smoke.spec.ts`) logs in through the real form with
  `signInThroughForm` on every run, so a regression in the form fails a test even when the
  setup project skipped it.

That is about one `POST /auth/login` per browser project per run (the limit is 10 per 600 s per
IP), and three on a run that signs in afresh. If a burst of runs trips it, the counter is one
key in the stack's Redis: `docker exec <redis container> redis-cli del rl:login:<your ip>`.

**Fixtures** (`fixtures/`):

| File          | Gives you |
| ------------- | --------- |
| `stack.ts`    | `apiUrl()`, `signIn`, `signInThroughForm` (and `submitLoginForm`, for a login page already on screen), `createProject`, `resetUploads`, `openUploads`, `closeUploads`, `dropFiles`, `rows`, `uploadRow` |
| `files.ts`    | `makeFiles` (real random-content files on disk), `touch`, `remove`, `rewrite`, `liveFilesDir` |
| `faults.ts`   | `throttleParts`, `failParts`, `hangParts`, `holdParts`, `stallParts`, `failInitiate`, `countRequests`, all on `page.route` (`throttleParts` also reads part sizes the page records); `trackUploads` (which S3 key is which file's, to aim `hangParts`, `holdParts` and `stallParts` at one file with `only`); `networkSwitch` (the browser's network down and up) |
| `scenario.ts` | What the Phase 3 specs share: `openProject`, `pngs` (PNGs in a folder the test may change, backdated), `removeScenarioFiles`, `recordUploadCalls` (initiates, part PUTs, presigns, aborts, with times), `until` and the panel helpers |
| `accounts.ts` | `primary()`, `secondary()` and the `Account` type |

`dropFiles` cannot drag from the desktop, so it builds the `DataTransfer` a browser would: real
`File` objects read from disk, delivered as `dragenter`, `dragover` and `drop`. It waits for the
drop region to be hydrated first: a drop that lands before React has attached its handlers goes
nowhere (seen in WebKit, about one run in eight). `rows` reads the uploads panel by
`data-testid="upload-row"`: `status` is the row's `data-status` (`queued`, `starting`, `uploading`,
`processing`, `complete`, `failed`, `cancelled`, `interrupted`, `elsewhere`, not the badge's
wording), `kind` its `data-detail` and `detail` the line it shows. A row without a status makes
`rows` throw. Both depend on how those parts of the page are built, and the selectors are kept in
`fixtures/stack.ts`.

`tests/queue.spec.ts` holds the upload queue's scenarios (see `SCENARIOS.md`, one `test()` per ID).
Most of them freeze the queue with `holdParts` (the files that started sit in Uploading with their
parts held, the rest wait), look at it, act, then release it. Q1 moves about 290 MB and takes under
a minute with the throttle at 2 MB/s; S2 is a 60 s window; the files they make are removed when each
test ends. P1 sets the instance storage cap and part size through the admin API and puts both back in
a `finally`; if a run is killed mid-test the cap stays, and the next P1 refuses to start until it is
reset (`PUT /instance/settings` with `storage_limit_bytes: 0` and `upload_part_size_bytes: 0`).

`tests/unreadable.spec.ts` (U1 to U3: files the browser can no longer read, parts that stop moving) and
`tests/network.spec.ts` (N1, N2: the network goes) hold the Phase 3 scenarios. U3 and U3b (and U2 in WebKit,
where a deleted file hangs the send) wait out the 90 s part watchdog, so each takes about 95 s (`test.setTimeout`
is 10 min); the files they change are under
`.live-files/` and are removed when each test ends. The watchdog's 5 min cap is not run here (see `SCENARIOS.md`).

`tests/accounts.spec.ts` holds the Phase 4 scenarios (A1 to A3: a log out, an accepted invite or another account's
sign-in in a second tab; R2: two tabs that Resume the same upload at once). Each runs two pages of one browser context,
which share localStorage as two tabs do. They sign in mid-test by writing the two tokens the way the login form does,
not through the form, to stay under `/auth/login`'s limit (A1 uses the form once). A2 invites a new user through the
admin API every run (`e2e-invitee-<ms>@example.com`; the API refuses the reserved `.test` domain), so each run leaves
one more user behind. R2 waits out the 150 s live window first, so it takes about three minutes.

`tests/fixtures.spec.ts` checks each fixture's observable effect (a throttled part really is
slow, an injected 500 reaches the page, a folder drop lands in the folder, ...) on every engine.
Run it after touching anything in `fixtures/`. One of its tests is marked `test.fail()`: it
passes by failing, because `throttleParts` must stop a test, not pass through, when it cannot
tell how big a part is. The list reporter draws such a pass as a red cross, but counts it as passed.

## Traps

- **Give each scenario's files names no other run used.** The uploads panel lists the
  account's earlier uploads from the server as well as this tab's, so `rows(page)` also
  returns rows from earlier tests (a hung upload comes back as "Elsewhere"). Find your rows by
  name.
- **Random bytes are not a valid video.** A `.mp4` from `makeFiles` uploads fine, then reads
  "Processing" until the transcoder has retried and given up, minutes later. That is enough for
  anything about the transfer. For a row that finishes, name the file `.png`: `makeFiles` then
  writes a valid image of exactly the size asked for, padded with random bytes, and the row
  reaches "Ready" in a second or two.
- **Do not leave many rows in "Processing".** The app opens one event stream (`/events/<project>`)
  per project that has a processing upload, and each stays pending. In WebKit, with several such
  projects, pages took tens of seconds to load and uploads to start, and the stall ended when one
  of those requests was cancelled. The likely cause is the browser's limit of six connections per
  host over HTTP/1.1. Use `.png` files unless a scenario is about video.
- **The grid only refetches on its own once a row is "Ready".** After a "Processing" row, reload
  to see the asset.
- **A file's modification time means a second to WebKit.** WebKit compares a picked file's modification time at one-second
  resolution, so a `touch` within a second of the file being written is not noticed (measured: a `touch` 350 ms
  after the write went unnoticed in one run of three). `pngs` in `fixtures/scenario.ts` backdates its files by a
  minute, as a real pick would be; do the same for any file you `touch`.
- **`context.setOffline(true)` makes files unreadable in WebKit.** In Playwright's WebKit it also fails reads of
  file-backed blobs (`file.slice(0, 1).arrayBuffer()` rejects with `NotReadableError`), which no browser does when
  the wifi goes; the app rightly calls that a file that changed. Use `networkSwitch(context, browserName)`, which
  uses `setOffline` where it is faithful and, in WebKit, a route that aborts every request to the API and the bucket.
- **A part must be bigger than the sockets hold to stall.** A part of 2 MB is "fully sent" to WebKit before a server that
  has stopped reading has seen most of it, and the part then waits on the 5 min answer clock instead of the 90 s one.
  `stallParts` needs a part of 10 MB (a file of 20 MB), which both engines report as partly sent.
- **Faults act on one page.** `throttleParts` and the others apply to the `page` they are given
  from the moment they are called until it closes; call them before `page.goto` when the page
  should be under them from the first request.

## Files that are never committed

`e2e/node_modules`, `test-results`, `playwright-report`, `.live-files/` (files a scenario changes
while they upload), and **`.accounts.json` and `.auth/`, which hold passwords and tokens.**

## Known gaps

- **Firefox does not launch on the macOS machine this was written on (Darwin 27).**
  `pnpm test:firefox` starts Playwright's Firefox 1511 (headless), which then sits at 100% of
  one core and never finishes launching, so every test fails with
  `browserType.launch: Timeout 180000ms exceeded`. Its stderr says
  `sandbox_extension_issue_file_to_process failed ... plugin-container.app: 1 (Operation not
  permitted)` and `RenderCompositorSWGL failed mapping default framebuffer`. The smoke scenario
  is therefore verified on Chromium and WebKit only. The `firefox` project is kept for machines
  where it launches; if you hit the same hang, run `pnpm test:chromium` and `pnpm test:webkit`.
