// Live Chrome probe (the script in LIVE-CHROME.md section 2.4, kept here as a file so evaluate_script can load it with sourcePath).
// Keep in sync with LIVE-CHROME.md. Install order: ffq-probe.js, ffq-extras.js, ffq-helpers.js, ffq-fast.js.
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
