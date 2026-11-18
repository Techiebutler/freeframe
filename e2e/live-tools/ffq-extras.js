// Stand-ins for the Playwright faults, plus request logs the probe does not keep: hold/release/pace (holdParts, throttleParts),
// failInitiate (coded 503) and delayInitiateMs, the initiate/part/presign logs, the ff-uploads watcher, and panel helpers (rows, tally, drop).
// Needs ffq-probe.js first. See LIVE-CHROME.md section 9.
(() => {
  const q = window.__ffq
  if (!q) return 'no probe'
  if (q.__extras) return 'extras already installed'
  q.__extras = true
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const pathOf = (raw) => { try { return new URL(raw, location.href).pathname } catch { return String(raw) } }
  const isPartPut = (info) => {
    if (!info || info.method !== 'PUT') return false
    try { const u = new URL(info.url, location.href); return u.searchParams.has('partNumber') && u.searchParams.has('uploadId') } catch { return false }
  }

  // ── logs the probe does not keep ──────────────────────────────────────────────
  q.initiates = [] // { t, name, file, bytes, path, status, doneAt, uploadId, chunk, code, fake }
  q.partLog = [] // { t, uploadId, partNumber, size }
  q.presignLog = [] // { t }
  const baseMark = q.mark
  q.mark = (label) => { q.initiates = []; q.partLog = []; q.presignLog = []; q.saved = []; return baseMark(label) }

  // ── stand-ins for the Playwright faults ──────────────────────────────────────
  // gate.hold: part PUTs are not sent until release() (holdParts). gate.rate: each part waits size/rate seconds
  // before it is sent (throttleParts). An unsent part that the app aborts ends as the browser would end it.
  q.gate = { hold: false, rate: 0 }
  q._gated = []
  q.held = () => q._gated.length
  const probeSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.send = function (body) {
    const info = this.__ffq
    if (isPartPut(info)) {
      let u; try { u = new URL(info.url, location.href) } catch { u = null }
      q.partLog.push({ t: q.rel(), uploadId: u?.searchParams.get('uploadId'), partNumber: Number(u?.searchParams.get('partNumber')), size: body?.size ?? body?.byteLength ?? 0 })
      if (q.gate.hold || q.gate.rate) {
        const xhr = this
        const args = arguments
        const entry = { xhr, timer: null }
        const origAbort = xhr.abort
        const drop = () => { const i = q._gated.indexOf(entry); if (i >= 0) q._gated.splice(i, 1); return i >= 0 }
        entry.go = () => { if (!drop()) return; delete xhr.abort; probeSend.apply(xhr, args) }
        xhr.abort = function () {
          if (drop()) { clearTimeout(entry.timer); delete xhr.abort; xhr.dispatchEvent(new ProgressEvent('abort')); xhr.dispatchEvent(new ProgressEvent('loadend')); return }
          return origAbort.apply(xhr, arguments)
        }
        q._gated.push(entry)
        if (!q.gate.hold) entry.timer = setTimeout(entry.go, ((body?.size ?? body?.byteLength ?? 0) / q.gate.rate) * 1000)
        return
      }
    }
    return probeSend.apply(this, arguments)
  }
  q.hold = () => { q.gate.hold = true; return 'holding part PUTs' }
  q.release = () => { q.gate.hold = false; const list = q._gated.slice(); for (const e of list) e.go(); return { released: list.length } }
  q.pace = (bytesPerSec) => { q.gate.rate = bytesPerSec; return { rate: bytesPerSec } }

  // initiate: delay it, or answer it with the API's coded 503 (storage_unavailable, retry_after 5) n times.
  q.delayInitiateMs = 0
  q.failInitiate = 0
  const innerFetch = window.fetch
  window.fetch = async function (input, init) {
    const url = input instanceof Request ? input.url : String(input)
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const path = pathOf(url)
    let rec = null
    if (method === 'POST' && (/\/upload\/initiate$/.test(path) || /\/assets\/[^/]+\/versions$/.test(path))) {
      let b = {}
      try { b = JSON.parse(init?.body) } catch { /* not JSON */ }
      rec = { t: q.rel(), name: b.asset_name ?? null, file: b.original_filename ?? null, bytes: b.file_size_bytes ?? null, path, status: null, doneAt: null, uploadId: null, chunk: null, code: null }
      q.initiates.push(rec)
      if (q.delayInitiateMs) await sleep(q.delayInitiateMs)
      if (q.failInitiate > 0) {
        q.failInitiate -= 1
        rec.status = 503; rec.fake = true; rec.doneAt = q.rel(); rec.code = 'storage_unavailable'
        return new Response(JSON.stringify({ detail: { code: 'storage_unavailable', message: 'Could not reach storage to start this upload. Please retry.', retry_after: 5 } }), { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' } })
      }
    } else if (method === 'POST' && /\/upload\/presign-part$/.test(path)) {
      q.presignLog.push({ t: q.rel() })
    }
    try {
      const res = await innerFetch.apply(this, arguments)
      if (rec) {
        rec.status = res.status; rec.doneAt = q.rel()
        res.clone().json().then((j) => { rec.uploadId = j?.upload_id ?? null; rec.chunk = j?.chunk_size_bytes ?? null; rec.code = j?.detail?.code ?? null; rec.retryAfter = j?.detail?.retry_after ?? null }).catch(() => {})
      }
      return res
    } catch (e) {
      if (rec) { rec.status = 'network-error'; rec.doneAt = q.rel() }
      throw e
    }
  }

  // every write of the saved upload list, and whether it still holds row `id` (R1)
  q.saved = []
  q.watch = (id) => { q._watchId = id; q.saved = []; return id }
  const setItem = Storage.prototype.setItem
  Storage.prototype.setItem = function (k, v) {
    if (k === 'ff-uploads' && q._watchId) {
      try {
        const row = (JSON.parse(v).state?.files ?? []).find((f) => f.id === q._watchId)
        q.saved.push({ t: q.rel(), has: !!row, status: row?.status ?? null })
      } catch { q.saved.push({ t: q.rel(), has: null, status: null }) }
    }
    return setItem.call(this, k, v)
  }

  // ── page helpers ─────────────────────────────────────────────────────────────
  q.panel = () => Array.from(document.querySelectorAll('div.fixed')).find((d) => d.querySelector('h1,h2,h3,h4,h5,h6')?.textContent?.trim().startsWith('Uploads'))
  q.openAll = () => { const p = q.panel(); const b = p && Array.from(p.querySelectorAll('button')).find((x) => /^All/.test(x.textContent.trim())); if (b) b.click(); return !!b }
  q.rows = (only) => {
    const p = q.panel()
    if (!p) return null
    const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const all = Array.from(p.querySelectorAll('[data-testid="upload-row"]')).map((row) => {
      const editing = row.querySelector('input[aria-label="Asset name"]')
      return { name: editing ? editing.value : text(row.querySelector('p.font-medium, button[title="Rename"]')), status: row.getAttribute('data-status'), kind: row.getAttribute('data-detail') ?? '', detail: text(row.querySelector('div.mt-1')) }
    })
    return only ? all.filter((r) => r.name.startsWith(only)) : all
  }
  q.tally = (prefix) => { const r = q.rows(prefix); if (!r) return null; const t = {}; for (const x of r) t[x.status] = (t[x.status] ?? 0) + 1; return t }
  q.addInput = () => {
    document.getElementById('ffq-drop-input')?.remove()
    const input = document.createElement('input')
    input.type = 'file'; input.multiple = true; input.id = 'ffq-drop-input'
    input.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;width:220px;height:28px;background:#fff'
    document.body.appendChild(input)
    return { dropRegions: document.querySelectorAll('div.relative.flex-1.flex.min-w-0.h-full').length }
  }
  q.drop = (label, { keepMark = false } = {}) => {
    const input = document.getElementById('ffq-drop-input')
    const transfer = new DataTransfer()
    for (const f of Array.from(input.files)) transfer.items.add(f)
    const region = document.querySelector('div.relative.flex-1.flex.min-w-0.h-full')
    const box = region.getBoundingClientRect()
    const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }
    const mark = keepMark ? { kept: true, at: q.rel() } : q.mark(label)
    if (!keepMark) q.sampleRows(500)
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer, ...at }
      let ev = new DragEvent(type, init)
      if (ev.dataTransfer !== transfer) { ev = new MouseEvent(type, init); Object.defineProperty(ev, 'dataTransfer', { value: transfer }) }
      region.dispatchEvent(ev)
    }
    return { mark, files: transfer.files.length }
  }
  // one summary the report can quote
  q.summary = () => {
    const r = q.report()
    const samples = q.rowSamples
    const moving = samples.map((s) => (s.counts.starting ?? 0) + (s.counts.uploading ?? 0))
    return {
      now: r.now,
      kinds: Object.fromEntries(Object.entries(r.kinds).map(([k, v]) => [k, { n: v.started, done: v.finished, failed: v.failed, st: v.statuses, first: v.firstStart, last: v.lastStart }])),
      initiatesWithin: r.initiatesStartedWithin,
      peak: Object.fromEntries(Object.entries(r.peakInFlight).map(([k, v]) => [k, v.n + '@' + v.t])),
      longtasks: r.longtasks,
      samples: samples.length,
      maxMoving: moving.length ? Math.max(...moving) : null,
      over3: moving.filter((m) => m > 3).length,
    }
  }
  return 'extras installed'
})()
