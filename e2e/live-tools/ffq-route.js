// Per-file faults for part PUTs: send one part of a named file to a throwaway server (stall-server.js) or hold it unsent.
// Needs ffq-extras.js first (it finds the file by the upload id in q.initiates). See LIVE-CHROME.md section 9.
//   q.route['name.png'] = 'stall'   the next part PUT of that file goes to http://127.0.0.1:18777/stall: the browser reports real upload progress
//                                   (about 1 MB) and then nothing (the server stops reading). Phase 3, U3b.
//   q.route['name.png'] = 'hang'    ... to /hang: every byte is sent, the server never answers. Phase 3, the 5 min answer clock.
//   q.holdFile['name.png'] = n       the first n part PUTs of that file are never sent (an abort of one ends as the browser would end it).
// q.routeLog records { name, mode, openedAt, lastProgressAt, loaded, allSentAt, endedAt, status } for each.
(() => {
  const q = window.__ffq
  if (!q || !q.initiates) return 'no probe or extras'
  if (q.__route) return 'route already installed'
  q.__route = true
  q.route = {}
  q.holdFile = {}
  q.routeLog = []
  q.routeServer = 'http://127.0.0.1:18777'
  const nameOfUpload = (uid) => { const i = q.initiates.find((x) => x.uploadId === uid); return i && (i.file ?? i.name) }
  const open = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (String(method).toUpperCase() === 'PUT' && /partNumber=/.test(url) && /uploadId=/.test(url)) {
      const u = new URL(url, location.href)
      const name = nameOfUpload(u.searchParams.get('uploadId'))
      this.__routeName = name
      const mode = name && q.route[name]
      if (mode) {
        delete q.route[name]
        const rec = { name, mode, openedAt: q.rel(), lastProgressAt: null, loaded: 0 }
        q.routeLog.push(rec)
        this.upload.addEventListener('progress', (e) => { rec.lastProgressAt = q.rel(); rec.loaded = e.loaded })
        this.upload.addEventListener('load', () => { rec.allSentAt = q.rel() })
        this.addEventListener('loadend', () => { rec.endedAt = q.rel(); rec.status = this.status })
        // The query string is kept, so the probe still counts it as a part PUT.
        return open.call(this, method, q.routeServer + '/' + mode + u.search, ...rest)
      }
    }
    return open.call(this, method, url, ...rest)
  }
  const send = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.send = function () {
    const name = this.__routeName
    if (name && q.holdFile[name] > 0) {
      q.holdFile[name]--
      const xhr = this
      const rec = { name, mode: 'held', openedAt: q.rel() }
      q.routeLog.push(rec)
      xhr.abort = function () { rec.endedAt = q.rel(); delete xhr.abort; xhr.dispatchEvent(new ProgressEvent('abort')); xhr.dispatchEvent(new ProgressEvent('loadend')) }
      return
    }
    return send.apply(this, arguments)
  }
  return 'route installed'
})()
