# FreeFrame end-to-end tests

Real-browser tests ([Playwright](https://playwright.dev)) for the web app, driven against a
running dev stack. They exist for what unit tests cannot see: files read from disk by a real
browser, uploads that outlive a page, two tabs sharing one `localStorage`, an S3 endpoint
that misbehaves.

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

## How it works

**Accounts.** `fixtures/accounts.ts` creates two users once and caches them in
`e2e/.accounts.json`: `primary` is the first-run superadmin (`POST /setup/create-superadmin`),
`secondary` an ordinary member invited by it. If the database is wiped (the instance reports
`needs_setup` again) the cache is dropped and both are recreated.

**Sessions.** The `setup` project (`tests/auth.setup.ts`) signs each account in through the real
login form, in password mode, and saves the session to `e2e/.auth/<account>.json`. Tests call
`signIn(page, account)`, which loads that file, so a suite of any size makes two `/auth/login`
calls, against a limit of 10 per 600 s. A session whose refresh token still works is kept
rather than replaced, so back-to-back runs make none. Every browser project depends on `setup`,
which always runs in Chromium; a saved session is plain cookies and localStorage and loads in
any engine.

**Fixtures** (`fixtures/`):

| File          | Gives you |
| ------------- | --------- |
| `stack.ts`    | `apiUrl()`, `signIn`, `createProject`, `resetUploads`, `openUploads`, `dropFiles`, `rows` |
| `files.ts`    | `makeFiles` (real random-content files on disk), `touch`, `remove`, `rewrite`, `liveFilesDir` |
| `faults.ts`   | `throttleParts`, `failParts`, `hangParts`, `failInitiate`, `countRequests`, all on `page.route` |
| `accounts.ts` | `primary()`, `secondary()` and the `Account` type |

`dropFiles` cannot drag from the desktop, so it builds the `DataTransfer` a browser would: real
`File` objects read from disk, delivered as `dragenter`, `dragover` and `drop`. `rows` reads the
uploads panel's DOM. Both depend on how those parts of the page are built, and the selectors
are kept in `fixtures/stack.ts`.

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
