// Throwaway server for the live pass: answers the CORS preflight, then
//   /stall  reads ~256 KB of a PUT body and stops reading
//   /hang   reads the whole body and never answers
const http = require('node:http')
const PORT = Number(process.argv[2] || 18777)
const srv = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'PUT, OPTIONS', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': 'ETag', 'Access-Control-Max-Age': '600' }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); console.log(new Date().toISOString(), 'OPTIONS', req.url.split('?')[0]); return }
  const mode = req.url.startsWith('/hang') ? 'hang' : 'stall'
  let got = 0, paused = false
  console.log(new Date().toISOString(), req.method, mode, 'start')
  req.on('data', (c) => { got += c.length; if (mode === 'stall' && !paused && got >= 256 * 1024) { paused = true; req.pause(); console.log(new Date().toISOString(), 'paused after', got) } })
  req.on('end', () => console.log(new Date().toISOString(), mode, 'body fully read', got, '(no answer will be sent)'))
  req.on('close', () => console.log(new Date().toISOString(), 'closed after', got))
  res.on('error', () => {})
})
srv.requestTimeout = 0; srv.headersTimeout = 0; srv.timeout = 0
srv.listen(PORT, '127.0.0.1', () => console.log('listening', PORT))
