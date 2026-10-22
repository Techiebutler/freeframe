// The fallback for a locked DevTools MCP profile (LIVE-CHROME.md section 10): a small HTTP front for one real, headed Google
// Chrome that you started yourself with its own profile and --remote-debugging-port, driven over the DevTools protocol by
// Playwright connectOverCDP. Usage: node live-tools/cdp-driver.js <path to node_modules/playwright> <cdp port> <http port>
// It listens on 127.0.0.1 only and answers only requests that come from a local tool such as curl (see `allowed`), and it
// redacts the `token=` query parameter (the live-event URL carries the access JWT) from what it hands out.
const http = require('node:http')
const CDP = Number(process.argv[3] || 9333)
const PORT = Number(process.argv[4] || 9334)

/**
 * Replaces the value of every `token=` query parameter, so no access token leaves the driver. The value stops at the next
 * `&`, `#`, whitespace, quote, `<`, `>` or backslash, so a URL inside JSON text is redacted without eating the rest of it.
 */
function redact(text) {
  return String(text).replace(/([?&]token=)[^&#\s"'<>\\]*/g, '$1<redacted>')
}

/** `redact` applied to every string inside a JSON-able value (what a handler returns). */
function redactValue(value) {
  if (value === undefined) return value
  return JSON.parse(redact(JSON.stringify(value)))
}

/**
 * Whether a request to the driver may be served. A web page can reach a localhost port, so a request that carries an
 * `Origin` or a `Sec-Fetch-Site` header (every browser sends one or the other) is refused, and the `Host` must be exactly
 * this port on 127.0.0.1 or localhost (which also refuses DNS rebinding). curl sends neither header.
 */
function allowed(headers, port) {
  if (headers.origin !== undefined || headers['sec-fetch-site'] !== undefined) return false
  return headers.host === `127.0.0.1:${port}` || headers.host === `localhost:${port}`
}

module.exports = { redact, redactValue, allowed }
if (require.main !== module) return
const { chromium } = require(process.argv[2])

const PRESETS = {
  'Fast 4G': { latency: 165, downloadThroughput: 1012500, uploadThroughput: 168750 },
  'Slow 4G': { latency: 562.5, downloadThroughput: 180000, uploadThroughput: 84375 },
}

;(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`)
  const ctx = browser.contexts()[0]
  const pages = new Map() // id -> { page, net: [], console: [], dialogs: [], cdp }
  let next = 1
  const t0 = Date.now()
  const adopt = (page) => {
    for (const v of pages.values()) if (v.page === page) return
    const id = next++
    // dialogAnswer / dialogDelayMs: how this page's dialogs are answered (the `dialogs` command sets them). Dismiss at once
    // by default; a delay leaves the browser's own dialog on screen, and the page blocked, for that long.
    const rec = { page, net: [], console: [], dialogs: [], cdp: null, dialogAnswer: 'dismiss', dialogDelayMs: 0 }
    pages.set(id, rec)
    page.on('request', (r) => rec.net.push({ at: Date.now(), method: r.method(), url: r.url(), type: r.resourceType(), status: null, req: r }))
    page.on('requestfinished', async (r) => { const e = rec.net.find((x) => x.req === r); if (e) { try { e.status = (await r.response())?.status() ?? null } catch {} } })
    page.on('requestfailed', (r) => { const e = rec.net.find((x) => x.req === r); if (e) e.status = r.failure()?.errorText ?? 'failed' })
    page.on('console', (m) => rec.console.push({ at: Date.now(), type: m.type(), text: m.text().slice(0, 500) }))
    page.on('pageerror', (e) => rec.console.push({ at: Date.now(), type: 'pageerror', text: String(e).slice(0, 500) }))
    page.on('dialog', (d) => {
      const e = { at: Date.now(), type: d.type(), message: d.message(), answer: rec.dialogAnswer, answeredAt: null }
      rec.dialogs.push(e)
      setTimeout(() => {
        e.answeredAt = Date.now()
        ;(e.answer === 'accept' ? d.accept() : d.dismiss()).catch(() => {})
      }, rec.dialogDelayMs)
    })
    page.on('close', () => { rec.closed = Date.now() })
  }
  ctx.pages().forEach(adopt)
  ctx.on('page', adopt)
  const get = (id) => { const r = pages.get(Number(id)); if (!r) throw new Error('no page ' + id); return r }
  const cdpOf = async (rec) => (rec.cdp ??= await ctx.newCDPSession(rec.page))

  const handlers = {
    pages: async () => [...pages].filter(([, r]) => !r.closed).map(([id, r]) => ({ id, url: redact(r.page.url()) })),
    // window: true opens a new window (Target.createTarget newWindow), else a tab in the current window.
    new: async ({ url, window }) => {
      const s = await browser.newBrowserCDPSession()
      const waiting = ctx.waitForEvent('page', { timeout: 15000 })
      await s.send('Target.createTarget', { url: url || 'about:blank', newWindow: !!window })
      const page = await waiting
      adopt(page)
      await page.waitForLoadState('domcontentloaded').catch(() => {})
      return [...pages].find(([, r]) => r.page === page)[0]
    },
    goto: async ({ page, url }) => { await get(page).page.goto(url, { waitUntil: 'domcontentloaded' }); return redact(get(page).page.url()) },
    // Page.reload over the protocol (not a person's Reload button). nowait: return at once, since a dismissed beforeunload
    // leaves Playwright's promise unsettled.
    reload: async ({ page, nowait }) => {
      const p = get(page).page.reload({ waitUntil: 'domcontentloaded' })
      if (nowait) { p.catch(() => {}); return { started: Date.now() } }
      await p
      return redact(get(page).page.url())
    },
    // A script run on every new document of this page before the app's own (Page.addScriptToEvaluateOnNewDocument).
    init: async ({ page, path }) => { await get(page).page.addInitScript({ path }); return path },
    // Emulation.setFocusEmulationEnabled on the driver's own session. enabled: false does NOT reveal the page's real
    // visibility: Playwright's session keeps its focus emulation, and a background tab still read "visible" (measured in
    // phase 5; only `hasFocus()` went false). For a really hidden tab, stop the driver and use cdp-raw.js.
    focus: async ({ page, enabled }) => {
      const s = await cdpOf(get(page))
      await s.send('Emulation.setFocusEmulationEnabled', { enabled: !!enabled })
      return { enabled: !!enabled, at: Date.now() }
    },
    // The window holding this page (Browser.getWindowForTarget). Unverified for its purpose: it answered in phase 5, but the OS
    // screenshot of the browser's dialog it was meant for was never taken (`screencapture -R` lacked permission).
    bounds: async ({ page }) => {
      const s = await cdpOf(get(page))
      const { targetInfo } = await s.send('Target.getTargetInfo')
      const b = await browser.newBrowserCDPSession()
      return b.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId })
    },
    url: async ({ page }) => redact(get(page).page.url()),
    eval: async ({ page, fn, timeout }) => {
      const p = get(page).page.evaluate(`(${fn})()`)
      return redactValue(await (timeout ? Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout')), timeout))]) : p))
    },
    evalfile: async ({ page, path }) => redactValue(await get(page).page.evaluate(require('node:fs').readFileSync(path, 'utf8'))),
    files: async ({ page, selector, paths }) => { await get(page).page.setInputFiles(selector, paths); return paths.length },
    click: async ({ page, selector, text }) => {
      const p = get(page).page
      const loc = text ? p.getByText(text, { exact: true }).first() : p.locator(selector).first()
      await loc.click({ timeout: 10000 })
      return 'clicked'
    },
    fill: async ({ page, selector, value }) => { await get(page).page.locator(selector).first().fill(value, { timeout: 10000 }); return 'filled' },
    shot: async ({ page, path }) => { await get(page).page.screenshot({ path }); return path },
    front: async ({ page }) => { await get(page).page.bringToFront(); return 'front' },
    // offline: true | preset: 'Fast 4G' | neither: back to normal. Held by this process's CDP session.
    emulate: async ({ page, offline, preset }) => {
      const s = await cdpOf(get(page))
      await s.send('Network.enable')
      const c = preset ? PRESETS[preset] : { latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
      await s.send('Network.emulateNetworkConditions', { offline: !!offline, ...c })
      return { offline: !!offline, preset: preset ?? null, at: Date.now() }
    },
    net: async ({ page, match, since }) => get(page).net
      .filter((e) => (!since || e.at >= since) && (!match || new RegExp(match).test(e.method + ' ' + e.url)))
      .map(({ req, ...e }) => ({ ...e, url: redact(e.url.replace(/X-Amz-[^&]*/g, '').replace(/[?&]+$/, '')) })),
    console: async ({ page, since }) => get(page).console
      .filter((e) => !since || e.at >= since)
      .map((e) => ({ ...e, text: redact(e.text) })),
    dialogs: async ({ page, answer, delayMs }) => {
      const rec = get(page)
      if (answer) rec.dialogAnswer = answer
      if (delayMs !== undefined) rec.dialogDelayMs = delayMs
      return rec.dialogs
    },
    // Page.close over the protocol. runBeforeUnload: the page's beforeunload runs first, so it may ask (not a person's close
    // button or Cmd+W, which the protocol cannot press).
    close: async ({ page, runBeforeUnload }) => { await get(page).page.close({ runBeforeUnload: !!runBeforeUnload }); return { closed: !!get(page).closed, at: Date.now() } },
    closed: async ({ page }) => ({ closed: get(page).closed ?? null }),
    now: async () => Date.now(),
  }

  http.createServer((req, res) => {
    if (!allowed(req.headers, PORT)) {
      res.statusCode = 403
      res.end(JSON.stringify({ ok: false, error: 'forbidden' }))
      req.resume()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      const name = req.url.replace(/^\//, '')
      try {
        const out = await handlers[name](body ? JSON.parse(body) : {})
        res.end(JSON.stringify({ ok: true, out }))
      } catch (e) {
        res.end(JSON.stringify({ ok: false, error: String(e && e.message || e).slice(0, 2000) }))
      }
    })
  }).listen(PORT, '127.0.0.1', () => console.log('driver on', PORT, 'pages', pages.size, 'since', t0))
})().catch((e) => { console.error(e); process.exit(1) })
