// Phase 5: plain DevTools-protocol commands to your own Chrome (LIVE-CHROME.md section 10) with no Playwright attached, for
// what Playwright hides: it turns focus emulation on for every page it attaches to, so every tab reads visible and focused,
// and a session of your own cannot turn that off (measured: `Emulation.setFocusEmulationEnabled(false)` on the driver's
// second session left a background tab "visible"). Stop the driver first, then:
//   node live-tools/cdp-raw.js <cdp port> list
//   node live-tools/cdp-raw.js <cdp port> eval <target id prefix> '<expression>'   (awaited, returned by value, as JSON)
//   node live-tools/cdp-raw.js <cdp port> new [url]          a foreground tab in the current window
//   node live-tools/cdp-raw.js <cdp port> activate <prefix>  bring that tab to the front (a real tab switch)
//   node live-tools/cdp-raw.js <cdp port> close <prefix>
// A prefix must match exactly one page. Every command gives up after CDP_RAW_TIMEOUT_MS (default 15 000 ms), and a socket
// that closes early fails the command instead of leaving it waiting. Output goes through the driver's `token=` redaction.
// Needs Node 22 or later (global WebSocket). Talks to 127.0.0.1 only.
const { redact, redactValue } = require('./cdp-driver.js')

/** The one page whose target id starts with `prefix`; throws when none or several match. */
function findTarget(pages, prefix) {
  const hits = pages.filter((p) => p.targetId.startsWith(prefix))
  if (hits.length === 0) throw new Error('no page ' + prefix)
  if (hits.length > 1) throw new Error(`ambiguous prefix ${prefix}: ${hits.length} pages (${hits.map((p) => p.targetId.slice(0, 12)).join(', ')})`)
  return hits[0]
}

/** `promise`, or a rejection after `ms` saying what timed out. */
function withTimeout(promise, ms, what) {
  let timer
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms) })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

async function run(port, cmd, arg, expr) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('could not open the DevTools socket')) })
  let id = 0
  const waiting = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id) }
  }
  // A socket that closes (Chrome quit, the tab's renderer died) answers every pending command with an error.
  ws.onclose = () => { for (const done of waiting.values()) done({ error: { message: 'the DevTools socket closed' } }); waiting.clear() }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) return reject(new Error(method + ': the DevTools socket is not open'))
    const n = ++id
    waiting.set(n, (msg) => (msg.error ? reject(new Error(method + ': ' + msg.error.message)) : resolve(msg.result)))
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const pages = async () => (await send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page')
  try {
    if (cmd === 'list') {
      return (await pages()).map((p) => ({ id: p.targetId.slice(0, 8), url: redact(p.url), attached: p.attached }))
    } else if (cmd === 'eval') {
      const t = findTarget(await pages(), arg)
      const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)
      await send('Target.detachFromTarget', { sessionId })
      return redactValue(r.exceptionDetails ? { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text } : r.result.value)
    } else if (cmd === 'new') {
      return { id: (await send('Target.createTarget', { url: arg || 'about:blank' })).targetId.slice(0, 8), at: Date.now() }
    } else if (cmd === 'activate') {
      await send('Target.activateTarget', { targetId: findTarget(await pages(), arg).targetId })
      return { activated: arg, at: Date.now() }
    } else if (cmd === 'close') {
      return await send('Target.closeTarget', { targetId: findTarget(await pages(), arg).targetId })
    }
    throw new Error('unknown command ' + cmd)
  } finally {
    ws.close()
  }
}

module.exports = { findTarget, withTimeout }

if (require.main === module) {
  const [port, cmd, arg, expr] = process.argv.slice(2)
  const ms = Number(process.env.CDP_RAW_TIMEOUT_MS || 15000)
  withTimeout(run(port, cmd, arg, expr), ms, `cdp-raw ${cmd}`)
    .then((out) => { console.log(JSON.stringify(out)); process.exit(0) })
    .catch((e) => { console.error(redact(String((e && e.message) || e))); process.exit(1) })
}
