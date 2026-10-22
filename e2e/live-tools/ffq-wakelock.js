// Phase 5: what the page does with the Screen Wake Lock, from outside the app. Install it before the app runs (the driver's
// `init`, or the MCP's `navigate_page` `initScript`): it wraps `WakeLock.prototype.request` and logs every request, grant,
// refusal, `release()` call and `release` event (the browser drops a lock by itself when the tab is hidden), with the page's
// visibility at that moment. The log is mirrored to sessionStorage (`ffq-wl`), so the entries a document wrote before a
// reload or a navigation to /login can be read in the next one (`__wl.prev`). See LIVE-CHROME.md section 9.
;(() => {
  if (window.__wl) return
  const KEY = 'ffq-wl'
  let prev = []
  try { prev = JSON.parse(sessionStorage.getItem(KEY) ?? '[]') } catch { prev = [] }
  const doc = Math.random().toString(36).slice(2, 8) // which document wrote an entry
  const wl = (window.__wl = { doc, log: [], prev, sentinels: [] })
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(prev.concat(wl.log).slice(-400))) } catch { /* full or blocked */ } }
  const push = (ev, extra) => { wl.log.push({ at: Date.now(), doc, ev, vis: document.visibilityState, ...extra }); save() }
  push('document')
  document.addEventListener('visibilitychange', () => push('visibility'))
  window.addEventListener('pagehide', () => push('pagehide', { held: wl.held() }))
  wl.held = () => wl.sentinels.filter((r) => !r.s.released).map((r) => r.id)
  wl.state = () => ({ doc, vis: document.visibilityState, held: wl.held(), sentinels: wl.sentinels.map((r) => ({ id: r.id, released: r.s.released, grantedAt: r.grantedAt, releasedAt: r.releasedAt })) })
  wl.clearPrev = () => { prev = []; wl.prev = []; wl.log = []; save(); return 'cleared' }
  if (!('wakeLock' in navigator)) { push('no-api'); return }
  const proto = Object.getPrototypeOf(navigator.wakeLock)
  const request = proto.request
  let n = 0
  proto.request = function (type) {
    const id = ++n
    push('request', { id, type })
    return request.apply(this, arguments).then(
      (s) => {
        const rec = { id, s, grantedAt: Date.now(), releasedAt: null }
        wl.sentinels.push(rec)
        push('granted', { id })
        s.addEventListener('release', () => { rec.releasedAt = Date.now(); push('released', { id }) })
        const release = s.release
        s.release = function () { push('release-called', { id }); return release.apply(this, arguments) }
        return s
      },
      (e) => { push('refused', { id, error: String((e && e.name) || e) }); throw e },
    )
  }
  // A timeline of how many sentinels are held, written only when the number changes (with the rows of `prefix`, when the
  // probe is installed and the panel is open).
  wl.timeline = []
  wl.watch = (prefix, everyMs = 200) => {
    clearInterval(wl._t)
    wl.timeline = []
    wl._t = setInterval(() => {
      const held = wl.held().length
      let rows = null
      try {
        const r = window.__ffq?.rows?.(prefix)
        if (r) { rows = {}; for (const x of r) { const k = x.status + (x.kind && x.kind !== x.status ? '/' + x.kind : ''); rows[k] = (rows[k] ?? 0) + 1 } }
      } catch { rows = null }
      const sig = held + '|' + JSON.stringify(rows)
      if (sig !== wl._sig) { wl._sig = sig; wl.timeline.push({ at: Date.now(), held, vis: document.visibilityState, rows }) }
    }, everyMs)
    return 'watching ' + prefix
  }
  wl.stop = () => { clearInterval(wl._t); return wl.timeline.length }
})()
