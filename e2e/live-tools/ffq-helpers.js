// UI helpers for the live pass (set q.apiUrl when the API is not on http://localhost:18000): newProject (through the UI), clickRow, dropFrom, addInput2, waitRows, assets. Needs ffq-extras.js first.
(() => {
  const q = window.__ffq
  if (!q || q.__helpers) return 'no probe or installed'
  q.__helpers = true
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  q.sleep = sleep
  q.closePanel = () => { const el = document.elementFromPoint(innerWidth - 20, 300); el?.click(); return !!el }
  q.newProject = async (name) => {
    q.closePanel(); await sleep(300)
    document.querySelector('a[href="/projects"]').click()
    for (let i = 0; i < 50 && !Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'New Project'); i++) await sleep(200)
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'New Project').click()
    let input
    for (let i = 0; i < 50 && !(input = document.querySelector('input[placeholder^="e.g. Brand"]')); i++) await sleep(100)
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, name)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(100)
    const form = input.closest('form')
    if (form) form.requestSubmit(); else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    for (let i = 0; i < 100 && !/\/projects\/[0-9a-f-]{36}$/.test(location.pathname); i++) await sleep(200)
    for (let i = 0; i < 100 && !document.body.innerText.includes('No assets'); i++) await sleep(200)
    return { path: location.pathname, noAssets: document.body.innerText.includes('No assets') }
  }
  q.clickRow = (name, title) => {
    const p = q.panel()
    const row = Array.from(p.querySelectorAll('[data-testid="upload-row"]')).find((r) => (r.querySelector('button[title="Rename"]')?.textContent.trim() ?? r.querySelector('p.font-medium')?.textContent.trim()) === name)
    const b = row?.querySelector(`button[title="${title}"], button[title^="${title}"]`)
    if (!b) return { found: false, row: !!row }
    b.click(); return { found: true }
  }
  q.dropFrom = (id, label, keepMark) => {
    const input = document.getElementById(id)
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
  q.addInput2 = (id, offset = 8) => { document.getElementById(id)?.remove(); const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.id = id; i.style.cssText = 'position:fixed;left:8px;bottom:' + offset + 'px;z-index:2147483647;width:220px;height:28px;background:#fff'; document.body.appendChild(i); return id }
  q.assets = async () => {
    const token = localStorage.getItem('ff_access_token'); const id = location.pathname.split('/').pop()
    const res = await fetch((q.apiUrl ?? 'http://localhost:18000') + '/projects/' + id + '/assets?folder_id=root&limit=200', { headers: { Authorization: 'Bearer ' + token } })
    const body = await res.json(); const items = Array.isArray(body) ? body : (body.items ?? body.assets ?? [])
    return { http: res.status, names: items.map((a) => a.name).sort() }
  }
  q.waitRows = async (prefix, n, ok, timeout = 60000) => { const t0 = q.rel(); for (;;) { const r = q.rows(prefix) ?? []; if (r.length === n && r.every(ok)) return true; if (q.rel() - t0 > timeout) return false; await sleep(250) } }
  q.saved1 = (id) => { const f = JSON.parse(localStorage.getItem('ff-uploads') ?? '{}').state?.files ?? []; return f.find((x) => x.id === id) ?? null }
  return 'helpers installed'
})()
