# Live Chrome testing protocol

The automated suite (`e2e/`, Playwright) proves behaviour repeatably. It does not replace
watching the real app in a **real, headed Chrome**, where the browser's own networking
(six connections per host, throttling, sleep, the DevTools network log) behaves the way a user
sees it. Every phase of the upload queue therefore ends with a **live Chrome pass**: the
scenarios of that phase from `SCENARIOS.md`, driven through Chrome DevTools, with evidence
recorded in `e2e/live-runs/YYYY-MM-DD-phase-N.md`.

Never fall back to headless Chrome or to Playwright's bundled browser for this pass. If the DevTools browser
cannot start (profile locked by another Chrome), close only the Chrome that the DevTools MCP
started, or give the MCP its own profile; do not switch to a headless run. If the Chrome holding the
profile belongs to another session (phase 4: started the day before by another session's MCP server), leave it
alone and drive a headed Google Chrome of your own over the DevTools protocol (section 10).

The first run of this protocol is the **baseline** on unchanged `main`
(`live-runs/2026-10-21-baseline.md`, scenario Q1). Later phases compare against it.

Status words used below: **verified** means it was run in Task 0.3 and behaved as written;
**not exercised** means the recipe is written from the tools' documentation and the stack's
layout, and the first person to use it should check it before relying on it.

## 1. Tools

| Tool | Use | Status |
| --- | --- | --- |
| `chrome-devtools` MCP (`chrome-devtools-mcp` 1.11.0 here) | `new_page` (with `isolatedContext`), `navigate_page` (`initScript`, `handleBeforeUnload`), `take_snapshot`, `upload_file`, `click`, `fill`, `type_text`, `press_key`, `emulate`, `list_network_requests`, `get_network_request`, `list_console_messages`, `evaluate_script`, `take_screenshot`, `performance_start_trace` / `performance_stop_trace`, `handle_dialog`, `close_page` | verified, except `handle_dialog` and `screencast_*` (`get_network_request` returns headers and status but no timing) |
| `claude-in-chrome` tools with `gif_creator` | A recording of the user-visible flow, in the person's own Chrome. Use it for any failing scenario | not exercised (phase 6 made its GIFs with section 10's `screencast` and `live-tools/frames-to-gif.js`) |
| `docker` | storage stop/start and network black hole (section 4) | `stop`/`start` of `ffe2e-minio-1` verified in phase 2 (S1); black hole not exercised |

Limits of the DevTools MCP that shape the protocol:

- **Network emulation is presets only**: `Offline`, `Slow 3G`, `Fast 3G`, `Slow 4G`, `Fast 4G`.
  There is no custom rate such as "2 MB/s" (a custom rate needs a Chrome you started yourself
  with a remote debugging port, which is outside this protocol). The presets, from the MCP's own
  table (`PredefinedNetworkConditions`):

  | Preset | Download | Upload | Latency |
  | --- | --- | --- | --- |
  | `Fast 4G` | 1 012 500 B/s | **168 750 B/s** | 165 ms |
  | `Slow 4G` and `Fast 3G` | 180 000 B/s | 84 375 B/s | 562.5 ms |
  | `Slow 3G` | 50 000 B/s | 50 000 B/s | 2 000 ms |

  `Fast 4G` is the fastest, and at 168 750 B/s up even a 100 MB run takes 10 minutes, so a
  throttled scenario cannot finish a large set. Run the part the scenario is about throttled,
  then lift the throttle (or cancel) to reach an end state, and say so in the report. The cap is
  shared by every request of the page, so with 50 files in flight each sees 20 to 60 KB/s.

  **Rule for Q1 (and the baseline): Fast 4G from before the drop; take the probe `report()`, the
  `lsof` socket count and a screenshot at about +5 s, +20 s, +100 s and +160 s; at +160 s lift
  the throttle with a bare `emulate`, wait for the last row to reach an end state, then read the
  rows. Record the time of the lift.** (The baseline lifted at +167.7 s, 8 s after its +159 s
  sample.)
- **There is no request-blocking tool.** Section 4 gives an in-page stand-in (`__ffq.block`).
- **Files the MCP writes or reads must sit inside the workspace root** (this repository, or its
  worktree): `take_screenshot` `filePath`, `performance_stop_trace` `filePath` and
  `evaluate_script` `sourcePath` refuse the scratch directory. Write to `e2e/.live-files/` (it
  is gitignored) and move the file to the scratch location afterwards.
- `emulate` replaces every emulation setting on that page on each call, so pass all you want
  in one call. It is per page (`pageId`).
- `take_snapshot` on the projects list is huge once the instance has many projects. On list
  pages, drive the page with `evaluate_script` instead.
- `navigate_page` `initScript` runs on the next navigation's new document, before the app. It
  is how the probe (section 2.4) is installed. A reload or a new URL clears the network list and
  console log, so collect evidence before navigating away (or pass `includePreservedRequests` /
  `includePreservedMessages`).

## 2. Setup

### 2.1 Variables (parameterise every URL and command)

```bash
# Where the stack under test lives. Values shown are the stock defaults;
# the `ffe2e` stack from e2e/README.md uses the values in the comments.
export E2E_BASE_URL=http://localhost:3000     # web          ffe2e: http://localhost:13000
export E2E_API_URL=http://localhost:8000      # API          ffe2e: http://localhost:18000
export E2E_STORAGE_URL=http://localhost:9000  # public S3    ffe2e: http://localhost:19000

# How to run docker compose against it.
# stock: docker compose -f docker-compose.dev.yml
# ffe2e: docker compose -p ffe2e --env-file $DIR/.env -f docker-compose.dev.yml -f $DIR/docker-compose.e2e.override.yml
export E2E_COMPOSE="docker compose -f docker-compose.dev.yml"
```

The stack must be running **the phase branch** (the worktree is bind-mounted into the dev
containers, so `apps/web` and `apps/api` hot-reload; Celery workers need a restart after
backend task changes). Record the commit in the report: `git rev-parse --short HEAD`.

### 2.2 A fresh browser context, signed in as `primary`

1. Open the app in a **new isolated context**: `new_page` with `url: $E2E_BASE_URL/login` and
   `isolatedContext: "<run name>"` (for example `q1-baseline`). The context has its own cookies
   and storage, so nothing from earlier runs or from the person's own sessions leaks in. Pages
   opened with the same `isolatedContext` name share that storage (this is how a second tab
   sees the same login and the same `ff-uploads`); a different name is a separate browser.
2. Confirm it is headed: the Chrome main process has no `--headless` flag
   (`ps -axo command | grep "^/Applications/Google Chrome.app/Contents/MacOS/Google Chrome " | grep -c -e --headless`
   prints 0), and note the version:
   `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version`.
3. Sign in as `primary` **through the login form** (the form opens in magic-code mode; click
   "Sign in with password instead"). The credentials are in `e2e/.accounts.json` (gitignored;
   never print or commit the password). To keep the password out of the log, put it on the
   clipboard and read it inside the page (verified on macOS):

   ```bash
   node -e "console.log(require('./e2e/.accounts.json').primary.email)"   # fill this into the email box
   node -e "process.stdout.write(require('./e2e/.accounts.json').primary.password)" | pbcopy
   ```

   then, with the password box focused, `evaluate_script`:

   ```js
   async () => {
     const text = await navigator.clipboard.readText()
     const p = document.querySelector('input[type=password]')
     p.focus()
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(p, text)
     p.dispatchEvent(new Event('input', { bubbles: true }))
     return { len: p.value.length }
   }
   ```

   click "Sign in", and clear the clipboard: `printf '' | pbcopy`. (`press_key` `Meta+V` does
   not paste; `fill` works but writes the password into the tool-call log.)

   **In a fresh isolated context `readText()` hangs** (`navigator.permissions.query({name:'clipboard-read'})` says
   `prompt`, and the browser's permission bubble cannot be answered through the MCP; the call times out). Then use a file:
   write the password to a mode-0600 file **inside the workspace** (`e2e/.live-files/pw.txt`; the MCP refuses paths outside
   it), inject `<input type=file id=pwin>` with `evaluate_script`, `upload_file` the file into it, read it in the page
   (`await document.getElementById('pwin').files[0].text()`), set the password box exactly as above, click "Sign in", and `rm`
   the file at once. The password is in the file and in the page, never in a tool call. (Verified in phase 2.)
4. Create a project through the UI with a name no earlier run used ("New Project", type the
   name, Enter). The uploads panel lists the account's earlier uploads too, so unique file
   names matter as much as a unique project.

### 2.3 Test files, generated with the `fixtures/files.ts` conventions

`makeFiles` is TypeScript with extension-less imports, which plain `node` cannot load, so
compile it once into a throwaway directory and call the compiled copy:

```bash
cd e2e
OUT=$(mktemp -d)
pnpm exec tsc fixtures/files.ts --outDir "$OUT" --module commonjs --target es2022 \
  --esModuleInterop --skipLibCheck --types node
# then a generator script that calls require("$OUT/files.js").makeFiles(dir, specs)
```

Files land in `e2e/.live-files/<set>/` (gitignored). Names keep a real extension (the browser
derives the MIME type from it), a `.png` is a valid image that finishes processing in a
second, and every other extension is random bytes that upload fine and then sit in
"Processing" (the transcoder cannot decode them). Keep most files `.png`.

The **Q1 set** (50 files, 1 KB to 40 MB, 291.6 MiB, 42 PNG plus 4 mp4, 2 mp3, 1 jpg,
1 wav). Save as `$OUT/q1.js` and run `node $OUT/q1.js $OUT "$PWD/.live-files/q1"`:

```js
// Q1 file set: 50 mixed files, 1 KB to 40 MB, about 300 MB in total.
const path = require('node:path')
const { makeFiles } = require(process.argv[2] + '/files.js')
const KB = 1024, MB = 1024 * KB
const sizes = [
  // 8 tiny
  1*KB, 2*KB, 5*KB, 8*KB, 12*KB, 20*KB, 35*KB, 50*KB,
  // 20 small
  200*KB, 300*KB, 400*KB, 500*KB, 600*KB, 700*KB, 800*KB, 900*KB, 1*MB, 1.2*MB,
  1.4*MB, 1.6*MB, 1.8*MB, 2*MB, 2.2*MB, 2.5*MB, 2.8*MB, 3*MB, 3.4*MB, 3.8*MB,
  // 14 medium
  3*MB, 3.5*MB, 4*MB, 4.5*MB, 5*MB, 5.5*MB, 6*MB, 6.5*MB, 7*MB, 7.5*MB, 8*MB, 8.5*MB, 9*MB, 9.5*MB,
  // 8 large
  10*MB, 13*MB, 16*MB, 19*MB, 22*MB, 25*MB, 28*MB, 40*MB,
].map((b) => Math.round(b))
// Mostly valid PNGs (they finish processing at once); a few audio/video/jpeg files of random bytes
// (they upload fine and then sit in "Processing", as real undecodable media does).
const odd = new Map([[3,'mp4'],[11,'mp3'],[17,'jpg'],[24,'mp4'],[29,'wav'],[36,'mp4'],[42,'mp3'],[47,'mp4']])
const specs = sizes.map((bytes, i) => {
  const n = String(i + 1).padStart(2, '0')
  const ext = odd.get(i) ?? 'png'
  return { name: `q1-${n}-${bytes}b.${ext}`, bytes }
})
makeFiles(process.argv[3], specs).then((p) => {
  const total = specs.reduce((a, s) => a + s.bytes, 0)
  console.log(p.length + ' files, ' + (total / MB).toFixed(1) + ' MiB in ' + process.argv[3])
})
```

The **Q2 set** is 300 files of 200 KB: `makeFiles(dir, Array.from({length: 300}, (_, i) => ({ name: 'q2-' + String(i + 1).padStart(3, '0') + '.png', bytes: 200 * 1024 })))`.
(Task 0.3 ran a 40-file smoke of it, see the baseline.)

### 2.4 Install the probe

`list_network_requests` shows what the browser did; it has no timing and no concurrency. The
**probe** is a small script, installed before the app loads, that counts every upload request
by kind, tracks how many are in flight at once, samples the Uploads panel rows, and records
long tasks. It matches by method and path only, so it works on any port.

Install it by passing the script below as `initScript` to `navigate_page` (type `reload` on
the project page), or, once the page has loaded, with `evaluate_script` `sourcePath` on `live-tools/ffq-probe.js` (the same
script as a file; keep the two in sync; the requests the app makes later go through the patched `XMLHttpRequest` and `fetch`):

```js
(() => {
  if (window.__ffq) return
  // Request kinds the upload code makes. Matched on method and path only, so the same probe
  // works against the API on any port and against any S3 host.
  const classify = (method, raw) => {
    let u
    try { u = new URL(raw, location.href) } catch { return null }
    const p = u.pathname
    if (method === 'PUT' && u.searchParams.has('partNumber') && u.searchParams.has('uploadId')) return 'part-put'
    if (method === 'POST' && p.endsWith('/upload/initiate')) return 'initiate'
    if (method === 'POST' && p.endsWith('/upload/presign-part')) return 'presign'
    if (method === 'POST' && p.endsWith('/upload/complete')) return 'complete'
    if (method === 'POST' && p.endsWith('/upload/abort')) return 'abort'
    if (method === 'GET' && /\/upload\/[^/]+\/parts$/.test(p)) return 'parts-list'
    if (method === 'POST' && /\/assets\/[^/]+\/versions$/.test(p)) return 'new-version'
    return null
  }
  // The uploads panel, as stack.ts finds it: a row is `[data-testid="upload-row"]` and its status is its
  // `data-status` (queued, starting, uploading, processing, complete, failed, cancelled, interrupted,
  // elsewhere). The class selectors are the fallback for a build without those hooks (main, before the
  // queue): its badge text ("Uploading", "Ready", ...) is the status. If the panel's markup changes, change these.
  const ROW = '[data-testid="upload-row"], div.group.items-start'
  const BADGE = 'span.rounded-full'

  const q = (window.__ffq = {
    t0: null, // performance.now() at mark(); every report time is relative to it
    wall0: null,
    events: [], // { t, kind, phase: 'start'|'end', status, bytes }
    open: {}, // kind -> requests in flight now
    peak: {}, // kind -> { n, t } highest number in flight at once
    rowSamples: [], // { t, counts } from sampleRows()
    longtasks: [], // { t, ms }
    // Start a measurement window: zero the clock and forget everything recorded so far.
    mark(label) {
      q.t0 = performance.now()
      q.wall0 = new Date().toISOString()
      q.label = label || ''
      q.events = []
      q.peak = {}
      q.rowSamples = []
      q.longtasks = []
      for (const k of Object.keys(q.open)) if (q.open[k] > 0) q.peak[k] = { n: q.open[k], t: 0 } // already in flight
      return { label: q.label, wall: q.wall0 }
    },
    rel: () => Math.round(performance.now() - (q.t0 ?? 0)),
    report() {
      const kinds = {}
      for (const e of q.events) {
        const k = (kinds[e.kind] ??= { started: 0, finished: 0, failed: 0, statuses: {}, firstStart: null, lastStart: null })
        if (e.phase === 'start') {
          k.started += 1
          k.firstStart = k.firstStart ?? e.t
          k.lastStart = e.t
        } else {
          k.finished += 1
          const s = String(e.status)
          k.statuses[s] = (k.statuses[s] ?? 0) + 1
          if (!(e.status >= 200 && e.status < 300)) k.failed += 1
        }
      }
      const startedWithin = (kind, ms) => q.events.filter((e) => e.kind === kind && e.phase === 'start' && e.t <= ms).length
      return {
        mark: { label: q.label, wall: q.wall0 },
        now: q.rel(),
        kinds,
        initiatesStartedWithin: { '1s': startedWithin('initiate', 1000), '5s': startedWithin('initiate', 5000), '30s': startedWithin('initiate', 30000) },
        peakInFlight: q.peak,
        longtasks: { count: q.longtasks.length, over200ms: q.longtasks.filter((l) => l.ms > 200).length, worstMs: Math.max(0, ...q.longtasks.map((l) => l.ms)) },
      }
    },
    sampleRows(everyMs = 500) {
      clearInterval(q._rows)
      q._rows = setInterval(() => {
        const panel = Array.from(document.querySelectorAll('div.fixed')).find((d) => d.querySelector('h1,h2,h3,h4,h5,h6')?.textContent?.trim().startsWith('Uploads'))
        if (!panel) return
        const counts = {}
        for (const row of panel.querySelectorAll(ROW)) {
          const s = (row.getAttribute('data-status') ?? row.querySelector(BADGE)?.textContent ?? '?').replace(/\s+/g, ' ').trim()
          counts[s] = (counts[s] ?? 0) + 1
        }
        q.rowSamples.push({ t: q.rel(), counts })
      }, everyMs)
    },
    stopRows() { clearInterval(q._rows) },
    // In-page request blocking, the stand-in for DevTools' "Network request blocking" (the DevTools MCP has no
    // such tool). block('/upload/initiate') or block(/\.s3\.|:19000/): matching requests fail at once with a
    // network error (the XHR is re-pointed at 127.0.0.1:9, a port Chromium refuses to connect to; fetch rejects).
    // unblock() lifts it. Lost on reload, does not touch navigator.onLine, covers page fetch/XHR only.
    block(match) { q._blocked = match instanceof RegExp ? match : new RegExp(String(match).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); return String(q._blocked) },
    unblock() { q._blocked = null },
  })
  const blocked = (url) => !!(q._blocked && q._blocked.test(url))

  const begin = (kind) => {
    q.open[kind] = (q.open[kind] ?? 0) + 1
    const t = q.rel()
    if (!q.peak[kind] || q.open[kind] > q.peak[kind].n) q.peak[kind] = { n: q.open[kind], t }
    q.events.push({ t, kind, phase: 'start' })
  }
  const finish = (kind, status) => {
    q.open[kind] -= 1
    q.events.push({ t: q.rel(), kind, phase: 'end', status })
  }

  const open = XMLHttpRequest.prototype.open
  const send = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ffq = { method: String(method).toUpperCase(), url: String(url) }
    if (blocked(String(url))) return open.call(this, method, 'http://127.0.0.1:9/blocked-by-ffq', ...Array.prototype.slice.call(arguments, 2))
    return open.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function () {
    const info = this.__ffq
    const kind = info && classify(info.method, info.url)
    if (kind) {
      begin(kind)
      this.addEventListener('loadend', () => finish(kind, this.status || 'network-error'))
    }
    return send.apply(this, arguments)
  }

  const nativeFetch = window.fetch
  window.fetch = function (input, init) {
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const kind = classify(method, input instanceof Request ? input.url : String(input))
    const url = input instanceof Request ? input.url : String(input)
    if (blocked(url)) { if (kind) { begin(kind); finish(kind, 'blocked') } return Promise.reject(new TypeError('Failed to fetch (blocked by __ffq)')) }
    if (!kind) return nativeFetch.apply(this, arguments)
    begin(kind)
    return nativeFetch.apply(this, arguments).then(
      (res) => { finish(kind, res.status); return res },
      (err) => { finish(kind, 'network-error'); throw err },
    )
  }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) q.longtasks.push({ t: Math.round(e.startTime - (q.t0 ?? 0)), ms: Math.round(e.duration) })
    }).observe({ type: 'longtask', buffered: true })
  } catch { /* not supported in this engine */ }
})()
```

Verify: `evaluate_script` `() => typeof window.__ffq` returns `"object"`.

API (all on `window.__ffq`):

| Call | Meaning |
| --- | --- |
| `mark(label)` | Start a measurement window: zero the clock, forget everything recorded before. Call it in the same tick as the drop. |
| `report()` | `kinds` (per `initiate`, `presign`, `part-put`, `complete`, `abort`, `parts-list`, `new-version`: started, finished, failed, status counts, first and last start in ms since `mark`), `initiatesStartedWithin` (1 s, 5 s, 30 s), `peakInFlight`, `longtasks`. A request the app cancels (an XHR `abort()`, as in C3 and R3) ends with status 0 and is counted as `network-error`, so a cancelled part PUT looks like a network failure in `report()`; tell them apart by what the scenario did. |
| `sampleRows(ms)` / `stopRows()` | Every `ms` (default 500) count the panel's rows by status (the row's `data-status`; the badge text on a build without the hooks) into `rowSamples`. Counts only the rows the panel's current tab shows: the "Active" tab hides finished rows, "All" shows everything. |
| `block(match)` / `unblock()` | In-page request blocking (section 4). |
| `rowSamples`, `events`, `open` | Raw data. |

What "in flight" means: requests the app has handed to `XMLHttpRequest.send` / `fetch` and not
yet seen finish. Chrome keeps at most **six connections per host** over HTTP/1.1, so the rest
wait inside the browser. The probe's peak is therefore what the app asked for; the sockets
actually in use are measured separately (section 5, item 4, "Wire concurrency").

## 3. Driving uploads

**Drop path** (what Q1 to Q4 and most scenarios use; verified). The DevTools MCP cannot drag
from the desktop, so build the `DataTransfer` a browser would hand the page, from real files
read off disk.

1. Add a visible file input to the project page (`evaluate_script`; a hidden input is not in
   the accessibility tree, so give it a box):

   ```js
   () => {
     const input = document.createElement('input')
     input.type = 'file'; input.multiple = true; input.id = 'ffq-drop-input'
     input.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;width:220px;height:28px;background:#fff'
     document.body.appendChild(input)
     return { dropRegions: document.querySelectorAll('div.relative.flex-1.flex.min-w-0.h-full').length } // must be 1
   }
   ```
2. `take_snapshot`, find `button "Choose files"`, then `upload_file` with its `uid` and the
   absolute paths (in drop order; `ls | sort` gives the order the files were named in).
   Check: `() => Array.from(document.getElementById('ffq-drop-input').files).length`.
3. Set the fault (throttle, offline, block) **before** the drop, then in one `evaluate_script`
   (`waitForStableDom: false`) mark the probe and dispatch the drop:

   ```js
   () => {
     const input = document.getElementById('ffq-drop-input')
     const transfer = new DataTransfer()
     for (const f of Array.from(input.files)) transfer.items.add(f)
     const region = document.querySelector('div.relative.flex-1.flex.min-w-0.h-full')
     const box = region.getBoundingClientRect()
     const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }
     const mark = window.__ffq.mark('<scenario id and condition>')
     window.__ffq.sampleRows(500)
     for (const type of ['dragenter', 'dragover', 'drop']) {
       const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer, ...at }
       let ev = new DragEvent(type, init)
       if (ev.dataTransfer !== transfer) { ev = new MouseEvent(type, init); Object.defineProperty(ev, 'dataTransfer', { value: transfer }) }
       region.dispatchEvent(ev)
     }
     return { mark, files: transfer.files.length }
   }
   ```

   Remove the input afterwards (`document.getElementById('ffq-drop-input').remove()`); it sits
   over the bottom left of the page and ends up in screenshots. The region selector is the one
   `fixtures/stack.ts` uses (`PROJECT_DROP_REGION`); if the page's markup changes, change it in
   both places.
4. The Uploads panel opens by itself on a drop. Pick its **All** tab if the scenario is about
   terminal states.

**Dialog path** (the project's "Upload" button, its `UploadZone` file input, then "Start
upload"): the same files go through `upload_file`, but the app starts every file when "Start
upload" is clicked. Use it only for scenarios about the dialog. Not exercised.

`touch` / `rm` / `rewrite` for U1 and U2 act on the real files in `e2e/.live-files/`
(`touch f`, `rm f`, `head -c <n> /dev/urandom > f`). Chrome reads a `File` lazily, so a
change after the drop is exactly what those scenarios want. Not exercised.

## 4. Fault injection

| Fault | How | Status |
| --- | --- | --- |
| Throttle | `emulate` with `networkConditions: "Fast 4G"` (or `Slow 4G`, `Fast 3G`, `Slow 3G`; rates in section 1) on the page, before the drop. Lift: `emulate` with no `networkConditions`. | verified (Fast 4G; lifting it mid-run: the last `complete` started 2.6 s later) |
| Offline | `emulate` with `networkConditions: "Offline"`; back online with a bare `emulate`. Check: `navigator.onLine` is `false` and a `fetch` rejects with "Failed to fetch"; DevTools lists the request as `net::ERR_INTERNET_DISCONNECTED`. | verified (outputs in the baseline report, "Tooling checks") |
| Block a request class | `window.__ffq.block('/upload/initiate')` or `window.__ffq.block(/:19000/)` (a string is matched literally, a RegExp as given); `window.__ffq.unblock()`. The stand-in for DevTools' "Network request blocking", which the MCP lacks. Matching `fetch` calls reject at once with `TypeError: Failed to fetch (blocked by __ffq)`; matching `XMLHttpRequest`s are re-pointed at `http://127.0.0.1:9/blocked-by-ffq`, a port Chromium refuses to connect to (`net::ERR_UNSAFE_PORT`, so nothing is sent; to the app it is the same as any network error, status 0). The probe records them as `blocked` (fetch) and `network-error` (XHR). **Counting: for a blocked class the probe's `report()` is the authoritative count.** A blocked `fetch` never reaches DevTools; a blocked XHR is listed by `list_network_requests` under the substitute URL (a `PUT` and its `OPTIONS` preflight, both `ERR_UNSAFE_PORT`), not under the original. **Limits:** the block is lost on reload or navigation (so is the probe: reinstall with `initScript`); it does not change `navigator.onLine` or fire `offline` / `online` events, so N1 and N2 need `emulate` `Offline`; it covers page-level `fetch` and `XMLHttpRequest` only (not workers, `sendBeacon` or `EventSource`); and it fails requests instantly, never as a hang or a timeout (use the throttle or the docker faults for those). | verified on a fetch and on an XHR, with the DevTools side (outputs in the baseline report, "Tooling checks") |
| Storage down | `STORAGE=$($E2E_COMPOSE ps -q minio)`; `docker stop $STORAGE`; later `docker start $STORAGE`. (ffe2e: container `ffe2e-minio-1`.) The browser's part PUTs fail, and so does `/upload/initiate` (the API creates the multipart upload in storage); presigning signs locally, so expect it to keep answering. | verified in phase 2 (S1): with the container stopped, `/upload/initiate` answered the coded `503` (`storage_unavailable`, `retry_after` 5) in about 150 ms, seven times in 30 s; `docker start` and the container was healthy in 6 s and the next try went through |
| Storage black hole | `NET=$(docker inspect $STORAGE --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')` (ffe2e: `ffe2e_default`), then `docker network disconnect $NET $STORAGE`. Reconnect with `docker network connect --alias minio $NET $STORAGE` (the compose service name must come back as an alias or the API cannot resolve the host). Requests hang instead of being refused. | not exercised; check the reconnect before relying on it |
| Files changed mid-queue | `touch` / `rm` / rewrite / replace-by-rename on the files in `e2e/.live-files/` (section 3). A file whose parts are all in flight survives an `rm` (macOS keeps the unlinked file open); one with a part still to send fails that part at once (`net::ERR_FILE_NOT_FOUND`). | verified in phase 3 (U1, U2, X1, X1b, X3) |
| Second tab, same account | `new_page` with the **same** `isolatedContext` name. It shares localStorage and cookies with the first tab (verified: a second tab opened in the same context was already signed in; a page in a differently named context was not). Probe it too: `navigate_page` with the `initScript`. | verified (baseline report, "Tooling checks") |
| Second account at once | `new_page` with a **different** `isolatedContext` name, sign in as `secondary` there. In the same context, signing in as `secondary` replaces `primary`'s session for both tabs, which is what A2 and A3 want. | same-profile switch verified in phase 4 (A1 to A3, section 10's driver): a sign-in, log out or invite accepted in one tab or window reaches the others as `storage` events for `ff_access_token` / `ff_refresh_token` within a millisecond; a separate context not exercised |
| Sign-out or account switch elsewhere (A1 to A3) | In the second tab or window: the sidebar's account menu (narrow rail: `button[aria-haspopup="menu"][title="<account name>"]`), then the menu item "Log out"; sign in through the login form (`live-tools/ffq-login.js`); an invite: `POST /users/invite` from the first tab with its own token, open `/invite/<token>`, fill the form. `live-tools/ffq-auth.js` records the `storage` events and, per request, the account it was sent as. | verified in phase 4 |
| Short access tokens | Recreate only the stack's api container with `ACCESS_TOKEN_EXPIRE_MINUTES=1`: one extra compose file holding just that variable under `services.api.environment`, added after the stack's own `-f` files and `--env-file` (read them from the container's `com.docker.compose.project.config_files` / `working_dir` labels), `docker compose -p ffe2e --env-file <env> -f docker-compose.dev.yml -f <override> -f <extra> up -d --no-deps --no-build api`. Restore with the same command without the extra file and check `printenv ACCESS_TOKEN_EXPIRE_MINUTES` is empty and a refresh returns a 900 s token. A token in hand keeps its old lifetime: refresh once to get a short one. | verified in phase 4 (the restored container had its original config hash) |
| Offline exactly while a refresh is due | `ffq-auth.js`: `holdRefresh = true` holds the app's `POST /auth/refresh` at the page's `fetch`; once `refreshHeld()` is 1, go offline, then `releaseRefresh()`: the refresh goes out offline and fails `ERR_INTERNET_DISCONNECTED`. Set `holdRefresh = false` before going back online. It acts only on a refresh that starts while it is on: a refresh already in flight when the network drops (the case a person meets without the stand-in) is not covered, and no live run has caught one. | verified in phase 4 (T2) |
| `beforeunload` dialog (L1) | MCP: `navigate_page` takes `handleBeforeUnload` (`accept` or `dismiss`); for a dialog that is already open, `handle_dialog`. Section 10's driver: `dialogs {page, answer, delayMs}` sets how that page's dialogs are answered and after how long (the dialog stays up, and the page blocked, meanwhile), then `reload {page, nowait: true}` (`Page.reload` over the protocol; a dismissed prompt leaves Playwright's promise unsettled) or `close {page, runBeforeUnload: true}` (`Page.close` with the page's `beforeunload` run first). Both are protocol-driven: not a person's Reload button, close button or Cmd+W, which the protocol cannot press. The page needs a trusted click first (sticky activation): the driver's `click`. Proof it was the browser's modal: `dialogs` lists it with type `beforeunload`, and an `eval {timeout: 800}` sent while it is up times out. | MCP not exercised; driver verified in phase 5 (L1: reload and tab close, Stay and Leave) |
| Screen wake lock | `live-tools/ffq-wakelock.js` as an init script (MCP `initScript`, driver `init`): every request, grant, refusal, `release()` and browser `release` event with the visibility, kept across loads in sessionStorage (`__wl.prev`). From the OS, read-only: `pmset -g assertions` lists Chrome's `NoDisplaySleepAssertion` named "Blink Wake Lock" while a lock is held ("Capturing" is a screenshot). Needs a secure context (`http://localhost` is one). | verified in phase 5 (W1 to W4, V) |
| Hide the tab, show it again | Not through Playwright (every page reads visible, section 10). Stop the driver, then `live-tools/cdp-raw.js`: `new` opens a foreground tab in the same window (the first one goes `hidden`), `activate <id>` switches back, `eval <id> '<expr>'` reads the page. An id prefix must match exactly one page (an ambiguous one is an error); each command gives up after `CDP_RAW_TIMEOUT_MS` (15 s by default); output is `token=`-redacted. | verified in phase 5 (V) |
| Laptop sleep (wake and resume cases) | Close the lid for 2 minutes with the queue running, open it, and record what the rows show. `pmset sleepnow` does the same from a terminal. A person has to be present; the DevTools session may need `list_pages` afterwards to find its tab. An unattended agent must not do this (it ends the session): it belongs to the manual pass. | not exercised (phase 3: moved to the manual pass) |
| Busy main thread (Q2) | Optional: `emulate` with `cpuThrottlingRate: 4`. Report it if used. | not exercised |

The DevTools MCP can hold, delay and answer nothing, so the Playwright faults that scenarios use have in-page stand-ins
(section 9): `hold()` / `release()` for part PUTs, `pace(rate)`, `delayInitiateMs`, `failInitiate = n` (a coded 503),
`delayPartsMs` and a stand-in file chooser. Say in the report which ones a scenario used and what they are not (a blocked
part PUT is a network error, not an HTTP 503).

## 5. Evidence per scenario

For each scenario in the phase, record all of this. One section per scenario in the phase
report.

1. **Verdict** against the expectation in `SCENARIOS.md`, quoted. PASS or FAIL, never "looks
   fine".
2. **Request counts**, from two sources:
   - the probe: `evaluate_script` `() => window.__ffq.report()`: initiates, presigns, part
     PUTs, complete, abort, with status counts and `initiatesStartedWithin`;
   - the DevTools network log: `list_network_requests` with `resourceTypes: ["fetch"]` (the
     API calls) and `["xhr"]` (the part PUTs go to storage as XHR), `pageSize: 200`. The
     header "Showing 1-200 of N" is the count for that filter; the API calls include the
     page's own GETs, so count the `upload/initiate`, `upload/presign-part`, `upload/complete`
     and `upload/abort` lines. Do this before any navigation.

   For a normal run the two must agree (the baseline's did, count for count). **The DevTools list is a rolling window over
   the whole session, and SPA navigation does not clear it**: after a long run its oldest requests are gone (phase 2's Q1
   listed 50 to 52 of 62 part PUTs, the probe 62). Read it right after the scenario, the last page first (`pageIdx`), or
   count with the probe. **For a request
   class you blocked with `__ffq.block`, they cannot, and the probe's count is authoritative:**
   a blocked `fetch` is rejected in the page and never appears in `list_network_requests`, and a
   blocked XHR appears as `PUT` and `OPTIONS http://127.0.0.1:9/blocked-by-ffq
   [net::ERR_UNSAFE_PORT]`, not under its real URL. Say in the report which classes were
   blocked and where each count comes from.
3. **Console**: `list_console_messages`. **Any uncaught error fails the scenario.** Report
   errors and warnings by text; the baseline had none (only the React DevTools info line).
   One exception: an uncaught error that already exists on `main`, in code the branch has not changed and outside the feature
   under test, is reported as an observation and noted for a ticket. It does not fail the scenario, and the report must name it
   as a deviation (which scenario, the error, and how it was shown to predate the branch: reproduced on `main`, or only read in
   the code).
4. **Wire concurrency**, where the scenario is about how many uploads run at once (Q1, Q3):
   sockets Chrome really holds open to the storage host and to the API, sampled several times
   during the run (verified on macOS):

   ```bash
   STORAGE_PORT=${E2E_STORAGE_URL##*:}; API_PORT=${E2E_API_URL##*:}
   echo "$(date +%T) storage: $(lsof -nP -iTCP:$STORAGE_PORT -sTCP:ESTABLISHED | grep -c Google)  api: $(lsof -nP -iTCP:$API_PORT -sTCP:ESTABLISHED | grep -c Google)"
   ```

   Expect at most 6 per host. This is the HTTP/1.1 limit, not an app setting.
5. **Rows**: the panel's end state for every row of the scenario, by name:

   ```js
   () => {
     const panel = Array.from(document.querySelectorAll('div.fixed')).find(d => d.querySelector('h1,h2,h3,h4,h5,h6')?.textContent?.trim().startsWith('Uploads'))
     Array.from(panel.querySelectorAll('button')).find(b => /^All/.test(b.textContent.trim())).click()
     return Array.from(panel.querySelectorAll('[data-testid="upload-row"]')).map(row => ({
       name: (row.querySelector('p.font-medium, button[title="Rename"]')?.textContent || '').trim(),
       status: row.getAttribute('data-status'),   // queued | starting | uploading | processing | complete | failed | cancelled | interrupted | elsewhere
       kind: row.getAttribute('data-detail'),     // waiting-to-start, waiting-for-storage, resuming, finalizing, ...
       detail: (row.querySelector('div.mt-1')?.textContent || '').replace(/\s+/g, ' ').trim(),
     }))
   }
   ```

   and, from the server's side, the assets that landed (the page's own token is used and not
   printed):

   ```js
   async () => {
     const api = '<E2E_API_URL>'   // for example http://localhost:18000
     const token = localStorage.getItem('ff_access_token')
     const id = location.pathname.split('/').pop()
     const res = await fetch(api + '/projects/' + id + '/assets?folder_id=root&limit=200', { headers: { Authorization: 'Bearer ' + token } })
     const body = await res.json()
     const items = Array.isArray(body) ? body : (body.items ?? body.assets ?? [])
     const tally = {}
     for (const a of items) { const k = (a.status ?? '?') + '/' + (a.latest_version?.processing_status ?? a.processing_status ?? '?'); tally[k] = (tally[k] || 0) + 1 }
     return { http: res.status, count: items.length, tally }
   }
   ```
6. **Screenshot of the Uploads panel at the decisive moment**: `take_screenshot` with a
   `filePath` inside the workspace (`e2e/.live-files/shots/<id>-<what>.png`), then move it to the
   scratch location and link that path from the report. Do not commit images or recordings
   over 2 MB (none is committed by default; the report links the scratch path).
7. **A GIF for any failure**: record the failing flow with the `claude-in-chrome` tools and
   `gif_creator` in the person's own Chrome (the DevTools MCP also lists `screencast_start` /
   `screencast_stop`, not exercised), and link it from the report.
8. **Q2 only, a performance trace with its long-task summary** (verified):
   `performance_start_trace` with `reload: false`, `autoStop: false` and a `filePath` inside the
   workspace; drop; wait for the run; `performance_stop_trace` with the same `filePath`. The
   summary the tool prints is insights (CLS and so on), not long tasks, so read the long tasks
   from the saved trace: main-thread `RunTask` events of the page's renderer:

   ```bash
   node -e "
   const zlib=require('zlib'),fs=require('fs');
   const raw=fs.readFileSync(process.argv[1]), j=JSON.parse((raw[0]===0x1f&&raw[1]===0x8b?zlib.gunzipSync(raw):raw).toString());
   const ev=Array.isArray(j)?j:j.traceEvents, names=new Map();
   for(const e of ev) if(e.ph==='M'&&e.name==='thread_name') names.set(e.pid+':'+e.tid,e.args.name);
   const mains=new Set([...names].filter(([k,v])=>v==='CrRendererMain').map(([k])=>k)), by={};
   for(const e of ev) if(e.ph==='X'&&e.name==='RunTask'&&mains.has(e.pid+':'+e.tid)) (by[e.pid+':'+e.tid]??=[]).push(e.dur/1000);
   for(const [k,v] of Object.entries(by)) console.log(k,'tasks',v.length,'totalMs',Math.round(v.reduce((a,b)=>a+b,0)),'>50ms',v.filter(x=>x>50).length,'>200ms',v.filter(x=>x>200).length,'worstMs',Math.round(Math.max(...v)))
   " <trace.json.gz>
   ```

   The page's renderer is the process with by far the most tasks (several renderers show up when
   several tabs are open). The probe's `longtasks` (PerformanceObserver) should agree on the
   worst task within a millisecond or two, and it is the only source in a scenario that runs
   without a trace. The Q2 expectation is no main-thread task over 200 ms during the run.
   Traces are 20 MB or more (section 10's driver writes plain JSON, 380 MB for Q2's 24 s; the script reads gzip or plain JSON, and a
   file that big needs `node --max-old-space-size=6000`): keep them in the scratch directory, never commit them. **A trace holds the
   page's URLs unredacted, the live-event URL's `token=` (an access token) among them**: delete it when the numbers are read, or strip
   the `token=` values before keeping it.

## 6. The report

`e2e/live-runs/YYYY-MM-DD-phase-N.md` (the baseline is `YYYY-MM-DD-baseline.md`). Commit it
without screenshots or traces; link those from the scratch location. GIFs meant for a PR description may be committed under
`e2e/live-runs/media/` when each is under 2 MB and has been reviewed frame by frame for tokens, email addresses and anything else
that should not be published (the menu, the login form and error details are where they turn up); otherwise link them from scratch. Record the result
in `SCENARIOS.md`'s "Live Chrome run" column (verdict and a link to the section).

```markdown
# Live Chrome run, phase N, <date>

- Commit: <short sha>, branch <branch>; stack: web <E2E_BASE_URL>, API <E2E_API_URL>, storage <E2E_STORAGE_URL>
- Browser: Chrome <full version>, headed, isolated context <name>, macOS <version>; DevTools MCP <version>
- Files: <set, count, total size, where generated>
- Deviations from the protocol: <none | what and why>

## <ID> <scenario title>: PASS | FAIL
- Condition: <throttle / fault / accounts>
- Expectation (SCENARIOS.md): <quoted>
- Result: <what happened, with times since the drop>
- Request counts: initiate N, presign N, part PUT N, complete N, abort N (probe) | DevTools list: same / differs because ...
- Peak in flight (app): ...; sockets (lsof): ...
- Console: <none | each error or warning>
- Rows at the end: <counts by status, exceptions by name>
- Screenshot: <scratch path>   GIF: <scratch path | none>   Trace: <scratch path | n/a>
- Notes: <anything a reader needs>
```

## 7. Cleanup

- `close_page` for every page the run opened (this also ends the isolated context).
- Lift emulation (`emulate` with no settings) if the run ends while throttled.
- Leave `e2e/.live-files/` in place if the next phase will reuse the set (it is gitignored);
  delete it otherwise (`rm -rf e2e/.live-files`).
- Files named `.mp4`, `.mp3`, `.jpg`, `.wav` made by `makeFiles` leave rows in "Processing"
  (the transcoder retries for minutes); that is expected, and they hold an event stream open
  only while the page that uploaded them is open. Close the page.
- Never touch containers outside the stack under test.

## 8. Traps seen while writing this

- The Uploads panel opens on **Active**. `sampleRows` counts what that tab shows, so on a run
  where rows finish quickly the counts drop to zero for a different reason than "nothing
  uploading". Select **All** for terminal states.
- The panel also lists the account's earlier uploads from the server (the baseline's "All 70"
  was 50 of its own and 20 from earlier runs). Find rows by name.
- The first `list_network_requests` page of a long run is full of the page's own GETs. Filter
  by `resourceTypes` and read the `of N` total.
- The grid refetches assets and folders after every completion; after a burst of completions
  the network log is mostly those GETs.
- An injected file input that stays on the page ends up in screenshots. Remove it first.
- **Never `take_snapshot` with the Uploads panel open**: it lists every row of the account's history (about 400 lines
  after a few runs). Close the panel first (a click on the page beside it), or read the panel with `evaluate_script`.
  A drop opens the panel by itself, and so does starting an upload.
- **A reload is how a transfer is interrupted.** `navigate_page` `reload` keeps the tab's `sessionStorage`, so the row comes
  back Interrupted at once; a closed and reopened page is another tab and reads Elsewhere for 150 s. The reload drops the probe:
  reinstall it (section 9) and mind the clock, see the next point.
- **Resume has a 30 s window**: a row this tab stopped sending is "own" only for `OWN_STOP_GRACE_MS` (30 s) after its last
  heartbeat (up to 15 s old when the page died); a Resume that starts later and within 150 s of the server's last activity on the
  upload reads "Elsewhere" and sends nothing. Drive the click and the start inside it (the fast flow in section 9), or you are
  testing the guard, not the scenario (and the queue makes it reachable: phase 2's APP-BUG-1).
- **The Uploads panel's tabs**: Interrupted and Cancelled rows are in **Failed**, not Active. `rows()` and `q.rows()` read
  whichever tab is selected; pick All.
- A file named like an earlier run's file (the same set dropped twice) puts two rows of that name in the panel; give each run's
  files their own prefix, as the Playwright specs do.
- **A held part is still on the watchdog's clock.** `hold()` stops the part PUT at `XMLHttpRequest.send`, but the app armed its watchdog
  when it called `send`, so a hold longer than about 90 s ends in an abort and a retry (that is how U3 uses it). Release within a minute
  when the scenario is about something else.
- **`emulate` Offline after a throttle releases the throttled uploads.** Going from `Fast 4G` to `Offline` let the PUTs that were
  crawling answer 200 at once (every byte stored), so the next step, `/upload/complete`, met the outage (the rows went Interrupted
  with "Failed to fetch"). For an outage in the middle of a part, put the part on `route['name'] = 'stall'` (ffq-route.js) first: an
  emulated outage leaves a pending request pending, and only the watchdog ends it.
- **The tool calls between two commands cost seconds.** A 20 s outage written as "emulate Offline, wait, emulate back" took 27.7 s
  in N2; read the real times from the `online`/`offline` events (`window.addEventListener`) and report them, not the intended ones.
- **The access token expires mid-pass** (15 minutes by default): a burst of 401s followed by a `POST /auth/refresh` 200 in the console and the
  network list is the app refreshing it, not an upload fault.
- **A second open tab keeps the first tab's token fresh.** The live-event connection of any tab on a project page refreshes a token about
  to expire, and the new token reaches every tab as a `storage` event. To see an upload's own 401, refresh and resend, keep a single tab
  open (phase 4: with two tabs the uploading tab never saw a 401 in four minutes of 1-minute tokens).
- **The injected file inputs cover the narrow sidebar's account button.** `ffq-drop-input` and `ffq-pick` sit at the bottom left, over the
  account menu of the collapsed rail, so a real click on it times out ("intercepts pointer events"). Remove them (or skip them in a tab that
  only signs in and out) before using the menu.
- **A panel row read in the same call as `openAll()` comes back empty**: the click on "All" renders on the next frame. Read the rows in the
  next call, or after a short wait.
- **`sampleRows` counts every row the panel shows**, and the panel lists the account's earlier rows too (Failed and Interrupted ones from
  earlier scenarios), so its counts say nothing about one scenario after the first. Sample the scenario's own rows by name prefix
  (`q.rows(prefix)` in a `setInterval`).
- **The login rate limit** is 10 `POST /auth/login` per 600 s per IP. A pass that switches accounts back and forth (phase 4 signed in 6 times
  in 8 minutes) has to count them.
- **A tab sees another tab's new rows only when the account changes** (or from the server's history): a row added in tab B is not listed in
  tab A of the same account. Read each tab's own rows, and Local Storage (`ff-uploads`) for what is saved.
- **`has-text("All")` also matches "Cancel all queued"** (Playwright's `has-text` is a case-insensitive substring). With rows queued, a
  click meant for the panel's All tab cancels them (phase 5's closed-tab run). Use `button:text-matches("^All")` and
  `button:text-matches("^Active")`.
- **A `beforeunload` dialog left up blocks the page**: every `eval` waits until it is answered. Give the driver's `eval` a `timeout`
  while one may be open, and keep `delayMs` short when parts are held (the watchdog's clock keeps running).
- **`screencapture` needs Screen Recording permission** for the terminal; without it `screencapture -R` fails ("could not create image
  from rect"), and a page screenshot cannot be taken while a dialog holds the page. The dialog's evidence is then the `dialogs` entry
  and the blocked `eval`.
- **Two layers intercept a trusted click** (phase 6): the open Uploads panel's backdrop (`div.fixed.inset-0.z-40`) covers the page and the
  sidebar, so close the panel first (a click on the backdrop); and the floating "Powered by FreeFrame" badge sits over the project page's
  "Open in viewer to comment" link at a 1400 x 900 window (a real click lands on the badge; follow the link from the page instead).
  The injected file inputs must have `pointer-events: none` as well as `opacity: 0` once they are filled, or they intercept the
  account menu.
- **The shell in this environment is zsh**: `set -- $spec` does not split words, so a `for` loop over "port account" pairs passes the
  pair as one argument. Run such loops under `bash -c` or a script with a bash shebang.
- **A screenshot is a power assertion too**: `pmset -g assertions` lists one named "Capturing" for Chrome while it is taken. Only
  "Blink Wake Lock" is the page's wake lock.

## 9. Phase 2 stand-ins (`live-tools/`)

Twelve files (eight scripts for the page, plus the throwaway server, the two section 10 drivers and the GIF assembler), loaded with `evaluate_script` `sourcePath` (a path inside the workspace; `evaluate_script` after load works because
the app calls `XMLHttpRequest` and `fetch` afresh on every request; `initScript` is only needed for a page that sends at load):

| File | Gives you |
| --- | --- |
| `live-tools/ffq-probe.js` | the probe of section 2.4 (same code; keep the two in sync) |
| `live-tools/ffq-extras.js` | `hold()` / `release()` / `held()`, `pace(bytesPerSecond)`, `delayInitiateMs`, `failInitiate`, `initiates` (name, file, bytes, status, `uploadId`, `chunk`, `code`, `retryAfter`), `partLog`, `presignLog`, `watch(rowId)` / `saved` (every write of `ff-uploads` and whether the row is in it), `rows()`, `tally()`, `openAll()`, `addInput()`, `drop()`, `summary()` |
| `live-tools/ffq-helpers.js` | `newProject(name)` (through the UI, SPA navigation, the probe survives), `clickRow(name, title)`, `dropFrom(inputId)`, `addInput2(id, offset)`, `assets()`, `waitRows()`, `closePanel()` |
| `live-tools/ffq-fast.js` | a stand-in file chooser for Resume (`pickNext = true` then click Resume: the next file input the app clicks gets the files of `#ffq-pick`) and `delayPartsMs` (a deferred `/parts` answer, R3's route) |
| `live-tools/ffq-route.js` | per-file faults for part PUTs (phase 3): `route['name.png'] = 'stall'` or `'hang'` sends that file's next part PUT to the throwaway server below (real upload progress, then nothing; or every byte sent and no answer), `holdFile['name.png'] = n` holds its first n part PUTs unsent; `routeLog` has the times |
| `live-tools/ffq-auth.js` | phase 4: `apiLog` (every request to the API: method, path with ids replaced, the account it was sent as from the bearer token's `sub` (first 8 characters of the user id, never the token), status, time), `storageLog` (token and resume-claim writes, from this tab and the others), `me()` (account and seconds left on the token), `authSummary()`, `uploadCallsAs()`, `savedRows(prefix)` and `savedOwners()` (Local Storage `ff-uploads`, with `ownerId`), `claims()`; stand-ins `holdRefresh` / `releaseRefresh()` and `partsAnswerAt` (the `/parts` answer reaches the app at that wall time: two tabs learn "nobody is sending" in the same millisecond). Needs `ffq-probe.js` first; set `q.apiHost` when the API is not `localhost:18000` |
| `live-tools/ffq-login.js` | phase 4: on a login page, adds `#pwin`; put the mode-0600 password files (named `<account>.pw`) into it, then `__ffqLogin(email, account)` reads the file in the page, fills the form and clicks "Sign in". Delete the password files when the pass ends, at the latest |
| `live-tools/cdp-driver.js` | phase 4: the section 10 driver (phase 5 added `init`, `focus`, `bounds`, `reload {nowait}`, `close {runBeforeUnload}`, `dialogs {answer, delayMs}`; phase 6 added `filesraw`, `press`, `trace`, `metrics`, `screencast` and the `Fast 3G` / `Slow 3G` presets) |
| `live-tools/frames-to-gif.js` | phase 6: the driver's `screencast` frames to a GIF with ffmpeg (`node live-tools/frames-to-gif.js <dir> <out.gif> [stepSeconds] [fps] [width]`), the stand-in for `gif_creator`; prints the size |
| `live-tools/cdp-raw.js` | phase 5: plain DevTools-protocol commands with nothing of Playwright attached (`list`, `eval`, `new`, `activate`, `close`), for a real hidden tab (section 10). A unique id prefix, a timeout (`CDP_RAW_TIMEOUT_MS`), the driver's `token=` redaction on its output |
| `live-tools/ffq-wakelock.js` | phase 5: install before the app (init script): `__wl.log` (request, granted, refused, release-called, released, visibility, pagehide), `__wl.prev` (the previous documents' entries, from sessionStorage), `held()`, `state()`, `watch(prefix, ms)` (a timeline of locks held and that prefix's rows, written on change), `stop()`, `clearPrev()` |
| `live-tools/stall-server.js` | the throwaway server for `route` (`node e2e/live-tools/stall-server.js [port]`, default 18777, on 127.0.0.1): answers the CORS preflight, then `/stall` stops reading after 256 KB and `/hang` reads everything and never answers. Stop it with `kill <pid>` when done |

After a reload, one script reinstalls everything and adds the two inputs (`ffq-drop-input` and `ffq-pick`) and the hold:

```bash
cd e2e && cat live-tools/ffq-probe.js live-tools/ffq-extras.js live-tools/ffq-helpers.js live-tools/ffq-fast.js live-tools/ffq-route.js | sed 's/^(() => {$/;(() => {/' > .live-files/ffq-all.js
echo ";(() => { const q = window.__ffq; q.addInput2('ffq-drop-input', 8); q.addInput2('ffq-pick', 44); q.hold(); return 'ready' })()" >> .live-files/ffq-all.js
```

`ffq-route.js` must come after `ffq-extras.js` (it finds a file by the upload id in `q.initiates`) and does nothing until `q.route` or `q.holdFile` is set; when a scenario routes a part to the server, start `node e2e/live-tools/stall-server.js` first and `kill` it by its PID at the end. Exercised in phase 3: `hang` and `holdFile` in the 5 min clocks (U3c), `stall` in a smoke run (a 20 MiB file: 1 146 880 bytes sent, then nothing) and, in an earlier inline form, in U3b and X2b.

What each stand-in is not: `hold` and `pace` act on the part PUT at `XMLHttpRequest.send` (nothing reaches the network; an `abort()` of
an unsent part ends with `abort` and `loadend` events, as the browser would deliver); `pace` waits `size / rate` per part, it does not
share a bandwidth; `block()` makes a request fail at once (a network error), never a hang or an HTTP status; `failInitiate` answers
from the page, so the server never sees that call; the chooser stand-in skips the browser's picker (the real one is `upload_file` on
the app's own Resume or New Version button, which works too and is what R1 and V1 used).

**Fast resume flow** (to start a Resume inside the 30 s window): prepare the interrupted row (drop with `hold()`, wait for the row
to be saved with its ids), `navigate_page reload`, run `ffq-all.js`, `take_snapshot` (small, the panel is closed), `upload_file` the
file into `ffq-pick` and the queue into `ffq-drop-input`, then one `evaluate_script` that drops, waits for the queue to settle, sets
`pickNext`, clicks Resume and releases. That was written as "about 20 to 25 s from the reload", but five separate tool calls took **69 s** in the
phase 2 R1 re-run, and the click must land within 30 s of the row's last heartbeat (`OWN_STOP_GRACE_MS`), so count on one or two calls only.

**Fast resume flow, one call after the reload** (verified in the R1 re-run: 7.7 s from the heartbeat to the click). Do everything that needs a tool call
*before* the reload: create an `<input type=file multiple>`, `upload_file` the interrupted file and the queue into it, and store those `File`s in IndexedDB
(`indexedDB.open('ffq-pool', 1)`, an object store `f`, `store.put(file, file.name)`; a `File` comes back with its name, size, type and `lastModified`).
Then drop the interrupted file with `hold()`, wait for the row to be saved with its ids, wait for its **next heartbeat write** and call `location.reload()` from the page
(so the heartbeat is under a second old), and run **one** `evaluate_script` (`sourcePath` of one file: `ffq-probe.js`, `ffq-extras.js`, `ffq-helpers.js` and `ffq-fast.js`
concatenated, then your scenario) that reads the files back from IndexedDB, builds the inputs `ffq-pick` and `ffq-drop-input` with `new DataTransfer()`, drops the queue, waits for
3 Uploading and the rest queued, sets `pickNext` and clicks Resume. Record the heartbeat age at the click (`Date.now() - row.heartbeatAt` from `ff-uploads`).
To exercise APP-BUG-1 hold the queue for more than 30 s after the click. **Do not pass `File`s between tabs** (a second tab and a `BroadcastChannel`
crashed the renderer and took both tabs with it).

## 10. When the MCP's profile is held by another session: your own headed Chrome over the DevTools protocol

Verified in phase 4. The chrome-devtools MCP refuses to start ("The browser is already running for
`~/.cache/chrome-devtools-mcp/chrome-profile`") while any Chrome holds that profile. When that Chrome is not one this run started
(`ps -o ppid` names another session's `chrome-devtools-mcp`), do not close it. Start Google Chrome yourself, headed, with a profile of its
own, and drive it over the DevTools protocol:

```bash
SCR=$(mktemp -d)            # scratch: profile, screenshots, pid files
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=$SCR/profile --remote-debugging-port=9333 \
  --no-first-run --no-default-browser-check --window-size=1400,900 about:blank &
echo $! > $SCR/chrome.pid    # kill only this pid at the end
node e2e/live-tools/cdp-driver.js "$PWD/e2e/node_modules/playwright" 9333 9334 &  # Playwright 1.59 connectOverCDP
echo $! > $SCR/driver.pid
c() { curl -s -X POST "http://127.0.0.1:9334/$1" -d "${2:-}"; echo; }             # c <command> '<json>'
```

The driver answers JSON on `127.0.0.1:9334`: `pages`, `new {url, window}` (`window: true` opens a new window, otherwise a tab),
`goto`, `reload {page, nowait}`, `url`, `eval {page, fn, timeout}` (a function's source), `evalfile {page, path}` (the `ffq-*.js` scripts), `init {page,
path}` (a script on every new document of that page, before the app), `files {page, selector, paths}` (the stand-in for `upload_file`),
`click {page, selector}` and `fill` (trusted input), `press {page, key}`, `shot {page, path}`, `front`, `focus {page, enabled}`, `bounds {page}`,
`emulate {page, offline}` or `{page, preset: "Fast 4G"}` or `{page}` to lift it, `net {page, match, since}` (the page's requests
with status or `net::` error, the "DevTools list"), `console {page, since}` (with `pageerror` for uncaught errors), `dialogs {page,
answer, delayMs}` (the dialogs seen, and how the next ones are answered: dismiss at once by default), `close {page, runBeforeUnload}`,
`closed`. All pages are in the profile's one browser context, so every tab and window shares localStorage and cookies.

Added in phase 6 (the final pass): `filesraw {page, selector, paths}` (the protocol's `DOM.setFileInputFiles` with real paths, as the MCP's
`upload_file` does; **use it instead of `files`**, see below), `trace {page, action: 'start'|'stop', path}` (a performance trace, plain JSON; the
stand-in for `performance_start_trace` / `performance_stop_trace`; section 5 item 8's script reads it with `JSON.parse` instead of `gunzip`),
`metrics {page, gc}` (`Performance.getMetrics` and `Runtime.getHeapUsage`, after `HeapProfiler.collectGarbage` with `gc: true`), and
`screencast {page, action: 'start'|'stop', dir}` (JPEG frames and their timestamps; `live-tools/frames-to-gif.js` makes the GIF). Start the
Chrome with `--enable-precise-memory-info` when `performance.memory` is to be read (Chrome rounds it otherwise).

- **The driver's `files` (Playwright's `setInputFiles`) treats a `connectOverCDP` browser as remote**: it refuses more than 50 MB in all
  ("Cannot transfer files larger than 50Mb to a browser not co-located with the server") and hands the page in-memory copies, so a
  `touch` or `rm` of the file on disk never reaches the page (U1, U2 and X1 to X3 would pass or fail for the wrong reason). Phases 4 and 5
  used it with small files that nothing changed. Use `filesraw`.
- **`files` and `filesraw` put any local path into the page**: the driver's guard keeps web pages from calling it, but whatever path
  a command names is read by the browser and can be uploaded to the stack. Point them only at files made for the pass (under
  `e2e/.live-files/` or the scratch directory), never at a home directory, a key, or the accounts file.
- **`screencast` frames are the page as drawn, unredacted**, and `trace` files carry every URL the page requested, `token=` included:
  review frames before turning them into a GIF, and delete the frame directories and traces (or redact them) before keeping anything.
- **The driver dismisses every dialog by default**, so with files on their way a `location.reload()` from the page meets the leave
  guard's `beforeunload` and does not happen (phase 6, R1's first take). Set `dialogs {page, answer: 'accept'}` before a reload meant to
  interrupt uploads.
- **`lsof ... | grep -c Google` counts every Chrome on the machine.** With two of your own (or the person's) running, filter by the network
  service of yours: its PID is the child of your Chrome whose command line has `network.mojom.NetworkService`, then
  `lsof -nP -a -p <that pid> -iTCP:19000 -sTCP:ESTABLISHED`.

How it differs from the MCP:

- Network conditions are `Network.emulateNetworkConditions` on a DevTools session the driver keeps open per page (the condition ends if
  the driver stops). Offline behaves as with the MCP: `navigator.onLine` false, `offline` / `online` events, `ERR_INTERNET_DISCONNECTED`.
- `net` comes from Playwright's page events and does not list CORS preflights.
- **Every page reads `document.visibilityState` "visible" and `hasFocus()` true**, even a background tab: Playwright enables focus
  emulation on the pages it attaches to. Background-tab timer throttling is therefore not in play. `focus {enabled: false}` does not undo
  it (measured in phase 5: `hasFocus()` went false, a background tab still read "visible"; the emulation of Playwright's own session
  stands). For a scenario about a hidden tab, stop the driver (`kill $(cat $SCR/driver.pid)`; the page keeps running) and use
  `live-tools/cdp-raw.js` (`node e2e/live-tools/cdp-raw.js 9333 new`, `activate <id>`, `eval <id> '<expr>'`), then start the driver
  again. A restarted driver has new page ids and none of the old one's records, network conditions or `init` scripts: run `init` again.
- Screenshots and the network list are Playwright's, not DevTools'.
- The driver listens on 127.0.0.1 only and answers 403 to any request with an `Origin` or `Sec-Fetch-Site` header or a `Host`
  other than `127.0.0.1:<port>` / `localhost:<port>`, so a web page cannot drive it; curl is unaffected. It replaces every
  `token=` query value with `<redacted>` in `net`, `console`, `pages`, `url`, `goto`, `reload`, `eval` and `evalfile` (the
  live-event URL carries the access token), and so does `cdp-raw.js`.
- `bounds` is unverified for its purpose: it answers, but the OS screenshot of a dialog it was meant for has not been taken
  (`screencapture` needs Screen Recording permission, section 8).
- Stop the driver and the Chrome by the pids in `$SCR/driver.pid` and `$SCR/chrome.pid` (`kill $(cat $SCR/driver.pid)`), and
  delete the profile directory. Delete any compose or env dump you made in the scratch directory too: they hold `JWT_SECRET`.

