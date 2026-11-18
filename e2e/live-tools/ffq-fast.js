// A stand-in file chooser (pickNext + #ffq-pick) for Resume, and delayPartsMs for a deferred /parts answer. Needs ffq-helpers.js first.
(() => {
  const q = window.__ffq
  if (!q || q.__fast) return 'no probe or installed'
  q.__fast = true
  // stand-in file chooser: the next <input type=file> the app clicks (not ours) gets the files of #ffq-pick
  q.pickNext = false
  const click = HTMLInputElement.prototype.click
  HTMLInputElement.prototype.click = function () {
    if (this.type === 'file' && !this.id.startsWith('ffq') && q.pickNext) {
      q.pickNext = false
      const dt = new DataTransfer(); for (const f of Array.from(document.getElementById('ffq-pick').files)) dt.items.add(f)
      this.files = dt.files
      q.pickedCount = dt.files.length
      this.dispatchEvent(new Event('change', { bubbles: true }))
      return
    }
    return click.apply(this, arguments)
  }
  q.delayPartsMs = 0
  const f0 = window.fetch
  window.fetch = async function (input, init) {
    const url = input instanceof Request ? input.url : String(input)
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (method === 'GET' && /\/upload\/[0-9a-f-]{36}\/parts$/.test((() => { try { return new URL(url, location.href).pathname } catch { return url } })()) && q.delayPartsMs) { q.partsCalls = (q.partsCalls ?? 0) + 1; await new Promise((r) => setTimeout(r, q.delayPartsMs)) }
    return f0.apply(this, arguments)
  }
  return 'fast installed'
})()
