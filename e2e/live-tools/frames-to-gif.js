// Phase 6: turn the driver's screencast frames (cdp-driver.js `screencast`, a stand-in for gif_creator) into a GIF with ffmpeg.
//   node live-tools/frames-to-gif.js <frames dir> <out.gif> [stepSeconds=1] [fps=8] [width=800] [fromSec=0] [toSec=end]
// Picks the last frame at or before every `stepSeconds` of real time (frames come only when the page paints, so a quiet
// stretch repeats the frame before it), plays them at `fps` (so the GIF runs stepSeconds * fps times faster than real time),
// and writes a two-pass palette GIF. Prints the size, so it can be kept under the limit before it is committed.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const [dir, out, step = '1', fps = '8', width = '800', from = '0', to] = process.argv.slice(2)
const frames = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'))
if (!frames.length) throw new Error('no frames in ' + dir)
const t0 = frames[0].ts
const end = to ? Number(to) : frames.at(-1).ts - t0
const picked = []
let i = 0
for (let t = Number(from); t <= end + 1e-9; t += Number(step)) {
  while (i + 1 < frames.length && frames[i + 1].ts - t0 <= t) i++
  picked.push(frames[i].n)
}
const list = path.join(dir, 'pick.txt')
fs.writeFileSync(list, picked.map((n) => `file '${path.join(dir, String(n).padStart(5, '0') + '.jpg')}'\nduration ${1 / Number(fps)}`).join('\n') + '\n')
const ffmpeg = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg'
const vf = `scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', vf, '-r', String(fps), out], { stdio: 'inherit' })
console.log(JSON.stringify({ out, frames: picked.length, realSeconds: Math.round(end - Number(from)), gifSeconds: +(picked.length / Number(fps)).toFixed(1), bytes: fs.statSync(out).size }))
