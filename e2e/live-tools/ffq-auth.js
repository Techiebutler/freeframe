// Phase 4 (accounts): which account every API request is sent as, the refresh and the 401s, the token and claim traffic in
// shared storage, and a way to hold the token refresh. Needs ffq-probe.js first. Records the token's `sub` (the user id),
// never the token. See LIVE-CHROME.md section 9.
(() => {
  const q = window.__ffq
  if (!q) return 'no probe'
  if (q.__auth) return 'auth already installed'
  q.__auth = true
  const subOf = (token) => {
    if (!token) return null
    try {
      const p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
      return { sub: typeof p.sub === 'string' ? p.sub : null, exp: typeof p.exp === 'number' ? p.exp : null }
    } catch { return { sub: '?', exp: null } }
  }
  const short = (id) => (id ? String(id).slice(0, 8) : null)
  const pathOf = (raw) => { try { const u = new URL(raw, location.href); return { host: u.host, path: u.pathname } } catch { return { host: '', path: String(raw) } } }
  const shape = (p) => p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
  const UPLOAD = /\/upload\/|\/assets\/<id>\/versions$|\/me\/assets/

  // ── every request to the API: who it was sent as, and how it ended ───────────
  q.apiLog = [] // { t, wall, method, path, as, status }
  const API = () => q.apiHost ?? 'localhost:18000'
  const record = (method, url, auth) => {
    const { host, path } = pathOf(url)
    if (host !== API()) return null
    const e = { t: q.rel(), wall: Date.now(), method, path: shape(path), as: auth ? short(subOf(String(auth).replace(/^Bearer /, ''))?.sub) : null, status: null }
    q.apiLog.push(e)
    return e
  }
  // The token refresh can be held at the fetch (holdRefresh = true) and let go with releaseRefresh(): the stand-in for
  // "DevTools offline exactly while a refresh is due" (hold it, emulate Offline, release, and the refresh goes out offline).
  q.holdRefresh = false
  q._refreshWaiters = []
  q.refreshHeld = () => q._refreshWaiters.length
  q.releaseRefresh = () => { const w = q._refreshWaiters.splice(0); w.forEach((go) => go()); return { released: w.length, at: q.rel() } }
  const f0 = window.fetch
  window.fetch = function (input, init) {
    const url = input instanceof Request ? input.url : String(input)
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const h = init?.headers ?? (input instanceof Request ? input.headers : undefined)
    const auth = h instanceof Headers ? h.get('Authorization') : (h?.Authorization ?? h?.authorization)
    const e = record(method, url, auth)
    const args = arguments
    const self = this
    const go = () => f0.apply(self, args).then(
      (r) => { if (e) { e.status = r.status; e.doneAt = q.rel() } return r },
      (err) => { if (e) { e.status = 'network-error'; e.doneAt = q.rel() } throw err },
    )
    // partsAnswerAt (epoch ms): the answer of `GET /upload/<id>/parts` reaches the app at that wall time and not before, so
    // two tabs given the same time both learn "nobody is sending this" in the same millisecond (R2's race, forced).
    if (e && method === 'GET' && /^\/upload\/<id>\/parts$/.test(e.path) && q.partsAnswerAt) {
      const at = q.partsAnswerAt
      return go().then((r) => new Promise((resolve) => setTimeout(() => { e.answeredAt = Date.now(); resolve(r) }, Math.max(0, at - Date.now()))))
    }
    if (e && e.path.endsWith('/auth/refresh') && q.holdRefresh) {
      e.heldAt = q.rel()
      return new Promise((resolve) => q._refreshWaiters.push(resolve)).then(() => { e.releasedAt = q.rel(); return go() })
    }
    return go()
  }
  const xOpen = XMLHttpRequest.prototype.open
  const xSet = XMLHttpRequest.prototype.setRequestHeader
  const xSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (method, url) { this.__ffqAuth = { method: String(method).toUpperCase(), url: String(url), auth: null }; return xOpen.apply(this, arguments) }
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (this.__ffqAuth && /^authorization$/i.test(k)) this.__ffqAuth.auth = v; return xSet.apply(this, arguments) }
  XMLHttpRequest.prototype.send = function () {
    const i = this.__ffqAuth
    const e = i && record(i.method, i.url, i.auth)
    if (e) this.addEventListener('loadend', () => { e.status = this.status || 'network-error'; e.doneAt = q.rel() })
    return xSend.apply(this, arguments)
  }

  // ── shared storage: the token and the resume claims, from this tab and from the others ──────────────
  q.storageLog = [] // { t, wall, from: 'this'|'other', key, op, as?, claim? }
  const watched = (k) => k === 'ff_access_token' || k === 'ff_refresh_token' || (k ?? '').startsWith('ff-upload-claim:')
  const describe = (k, v) => {
    if (v == null) return {}
    if (k === 'ff_access_token') { const s = subOf(v); return { as: short(s?.sub), exp: s?.exp } }
    if (k.startsWith('ff-upload-claim:')) { try { const c = JSON.parse(v); return { claim: { tab: short(c.tab), nonce: short(c.nonce), at: c.at } } } catch { return { claim: 'unreadable' } } }
    return {}
  }
  const sSet = Storage.prototype.setItem
  const sRemove = Storage.prototype.removeItem
  Storage.prototype.setItem = function (k, v) {
    if (this === window.localStorage && watched(k)) q.storageLog.push({ t: q.rel(), wall: Date.now(), from: 'this', key: k.replace(/:.*/, ':<row>'), op: 'set', ...describe(k, v) })
    return sSet.apply(this, arguments)
  }
  Storage.prototype.removeItem = function (k) {
    if (this === window.localStorage && watched(k)) q.storageLog.push({ t: q.rel(), wall: Date.now(), from: 'this', key: k.replace(/:.*/, ':<row>'), op: 'remove' })
    return sRemove.apply(this, arguments)
  }
  window.addEventListener('storage', (ev) => {
    if (ev.key !== null && !watched(ev.key)) return
    q.storageLog.push({ t: q.rel(), wall: Date.now(), from: 'other', key: ev.key === null ? '(clear)' : ev.key.replace(/:.*/, ':<row>'), op: ev.newValue == null ? 'remove' : 'set', ...describe(ev.key ?? '', ev.newValue) })
  })

  // ── summaries ────────────────────────────────────────────────────────────────
  q.me = () => { const s = subOf(localStorage.getItem('ff_access_token')); return { as: short(s?.sub), expiresIn: s?.exp ? Math.round(s.exp - Date.now() / 1000) : null } }
  q.authSummary = (since = 0) => {
    const by = {}
    for (const e of q.apiLog) {
      if (e.t < since) continue
      const k = `${e.method} ${e.path} as ${e.as ?? '-'}`
      const b = (by[k] ??= {})
      b[e.status ?? 'pending'] = (b[e.status ?? 'pending'] ?? 0) + 1
    }
    return by
  }
  q.uploadCallsAs = (since = 0) => {
    const as = {}
    for (const e of q.apiLog) if (e.t >= since && UPLOAD.test(e.path)) as[e.as ?? '-'] = (as[e.as ?? '-'] ?? 0) + 1
    return as
  }
  // The rows saved in shared storage (Application > Local Storage > ff-uploads), by name prefix.
  q.savedRows = (prefix = '') => (JSON.parse(localStorage.getItem('ff-uploads') ?? '{}').state?.files ?? [])
    .filter((f) => (f.assetName ?? '').startsWith(prefix))
    .map((f) => ({ name: f.assetName, status: f.status, owner: short(f.ownerId), error: f.error ?? null, ids: !!(f.versionId && f.uploadId), heartbeatAge: f.heartbeatAt ? Date.now() - f.heartbeatAt : null }))
  q.savedOwners = () => { const t = {}; for (const f of JSON.parse(localStorage.getItem('ff-uploads') ?? '{}').state?.files ?? []) { const k = short(f.ownerId) ?? '(none)'; t[k] = (t[k] ?? 0) + 1 } return t }
  q.claims = () => Object.keys(localStorage).filter((k) => k.startsWith('ff-upload-claim:')).map((k) => ({ key: k.slice(0, 30), ...describe(k, localStorage.getItem(k)) }))
  return 'auth installed'
})()
