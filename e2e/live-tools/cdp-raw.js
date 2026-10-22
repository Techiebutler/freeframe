// Phase 5: plain DevTools-protocol commands to your own Chrome (LIVE-CHROME.md section 10) with no Playwright attached, for
// what Playwright hides: it turns focus emulation on for every page it attaches to, so every tab reads visible and focused,
// and a session of your own cannot turn that off (measured: `Emulation.setFocusEmulationEnabled(false)` on the driver's
// second session left a background tab "visible"). Stop the driver first, then:
//   node live-tools/cdp-raw.js <cdp port> list
//   node live-tools/cdp-raw.js <cdp port> eval <target id prefix> '<expression>'   (awaited, returned by value, as JSON)
//   node live-tools/cdp-raw.js <cdp port> new [url]          a foreground tab in the current window
//   node live-tools/cdp-raw.js <cdp port> activate <prefix>  bring that tab to the front (a real tab switch)
//   node live-tools/cdp-raw.js <cdp port> close <prefix>
// Needs Node 22 or later (global WebSocket). Talks to 127.0.0.1 only.
const [port, cmd, arg, expr] = process.argv.slice(2)

async function main() {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const waiting = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id) }
  }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id
    waiting.set(n, (msg) => (msg.error ? reject(new Error(method + ': ' + msg.error.message)) : resolve(msg.result)))
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const pages = async () => (await send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page')
  const find = async (prefix) => {
    const t = (await pages()).find((p) => p.targetId.startsWith(prefix))
    if (!t) throw new Error('no page ' + prefix)
    return t
  }
  let out
  if (cmd === 'list') {
    out = (await pages()).map((p) => ({ id: p.targetId.slice(0, 8), url: p.url.replace(/([?&]token=)[^&]*/g, '$1<redacted>'), attached: p.attached }))
  } else if (cmd === 'eval') {
    const t = await find(arg)
    const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)
    await send('Target.detachFromTarget', { sessionId })
    out = r.exceptionDetails ? { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text } : r.result.value
  } else if (cmd === 'new') {
    out = { id: (await send('Target.createTarget', { url: arg || 'about:blank' })).targetId.slice(0, 8), at: Date.now() }
  } else if (cmd === 'activate') {
    await send('Target.activateTarget', { targetId: (await find(arg)).targetId })
    out = { activated: arg, at: Date.now() }
  } else if (cmd === 'close') {
    out = await send('Target.closeTarget', { targetId: (await find(arg)).targetId })
  } else {
    throw new Error('unknown command ' + cmd)
  }
  console.log(JSON.stringify(out))
  ws.close()
}
main().catch((e) => { console.error(String(e && e.message || e)); process.exit(1) })
