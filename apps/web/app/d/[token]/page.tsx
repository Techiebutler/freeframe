'use client'

import * as React from 'react'
import useSWR from 'swr'
import { Download } from 'lucide-react'
import s from './delivery.module.css'

interface DeliveryFile { name: string; url: string; size_bytes: number; mime_type: string }
interface Delivery {
  title: string; brand: string; version: number; video_url: string | null; files: DeliveryFile[]
  approved_by: string; approved_at: string
}
interface Clip { name: string; src: string; file: DeliveryFile | null }

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
const SCALE = [1, 0.84, 0.7, 0.62], DIM = [0, 0.4, 0.58, 0.7], OP = [1, 1, 0.9, 0]
const size = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`)
const two = (n: number) => (n < 10 ? '0' : '') + n

async function load(token: string): Promise<Delivery> {
  const res = await fetch(`${API_URL}/deliveries/${token}`)
  if (!res.ok) throw new Error(String(res.status))
  return res.json()
}

/** Videos of a delivery: the streamed one first, then any other video file. */
function clipsOf(d: Delivery): Clip[] {
  const videos = d.files.filter(f => f.mime_type.startsWith('video/'))
  const out: Clip[] = videos.map((f, i) => ({ name: f.name, src: i === 0 && d.video_url ? d.video_url : f.url, file: f }))
  if (!out.length && d.video_url) out.push({ name: d.title, src: d.video_url, file: null })
  return out
}

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function Notice({ title, text }: { title: string; text?: string }) {
  return <main className={s.root}><div className={s.center}><h1>{title}</h1>{text && <p>{text}</p>}</div></main>
}

/** Public hand-off page (no login): the approved video(s) and the download. */
export default function DeliveryPage({ params: { token } }: { params: { token: string } }) {
  const { data, error } = useSWR(`/d/${token}`, () => load(token), { shouldRetryOnError: false, revalidateOnFocus: false })
  const [cur, setCur] = React.useState(0)
  const [ratio, setRatio] = React.useState<Record<number, number>>({})
  const [live, setLive] = React.useState(false) // front card is playing with sound + controls
  const [playing, setPlaying] = React.useState<number | null>(null) // front video attached after first paint
  const [dragX, setDragX] = React.useState<number | null>(null)
  const drag = React.useRef<{ x: number; t: number; moved: boolean; h: number } | null>(null)
  const swallow = React.useRef(false)
  const clips = React.useMemo(() => (data ? clipsOf(data) : []), [data])

  const go = React.useCallback((i: number) => {
    setCur(c => { const n = Math.max(0, Math.min(clips.length - 1, i)); if (n !== c) { setLive(false); setPlaying(null) } return n })
  }, [clips.length])

  React.useEffect(() => {
    if (!clips.length || reduced()) return
    const t = setTimeout(() => setPlaying(cur), 400)
    return () => clearTimeout(t)
  }, [cur, clips.length])

  React.useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'ArrowRight') go(cur + 1); else if (e.key === 'ArrowLeft') go(cur - 1) }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [cur, go])

  if (error) {
    const gone = String((error as Error).message) === '404'
    return <Notice title={gone ? 'This link is no longer available' : "We couldn't load this page"} text={gone ? 'It may have expired or been replaced. Please ask your contact at Aditor for a fresh link.' : 'Please check your connection and reload.'} />
  }
  if (!data) return <main className={s.root}><div className={s.center}><div className={s.spin} role="status" aria-label="Loading" /></div></main>
  if (!clips.length) return <Notice title="Nothing to show yet" text="This delivery has no video. Please ask your contact at Aditor." />

  const when = new Date(data.approved_at).toLocaleDateString(undefined, { dateStyle: 'medium' })
  const front = clips[cur]
  const others = data.files.filter(f => !f.mime_type.startsWith('video/'))
  const many = clips.length > 1
  const title = data.brand ? `${data.brand} - ${data.title}` : data.title
  const dl = front.file ?? data.files[0]

  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    drag.current = { x: e.clientX, t: e.timeStamp, moved: false, h: e.currentTarget.getBoundingClientRect().height }
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return
    const dx = e.clientX - d.x
    if (!d.moved && Math.abs(dx) > 8) { d.moved = true; try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ } }
    if (d.moved) setDragX((dx > 0 && cur === 0) || (dx < 0 && cur === clips.length - 1) ? dx * 0.25 : dx)
  }
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current; drag.current = null; setDragX(null)
    if (!d?.moved) return
    const dx = e.clientX - d.x
    swallow.current = true; setTimeout(() => { swallow.current = false }, 0)
    if (Math.abs(dx) > d.h * 0.16 || Math.abs(dx) / Math.max(1, e.timeStamp - d.t) > 0.4) go(cur + (dx < 0 ? 1 : -1))
  }

  return (
    <main className={s.root}>
      <header className={s.head}><div className={`${s.mark} ${s.rise}`}>aditor</div></header>

      <section className={s.hero}>
        <h1 className={`${s.title} ${s.rise}`} style={{ '--i': 1 } as React.CSSProperties}>{title}</h1>
        <p className={`${s.sub} ${s.rise}`} style={{ '--i': 2 } as React.CSSProperties}>Version {data.version} · approved {when}</p>
      </section>

      <section className={s.wrap} aria-label="Videos">
        <div
          className={`${s.gal} ${dragX !== null ? s.dragging : ''} ${many ? '' : s.single}`} role="group" aria-roledescription={many ? 'carousel' : undefined}
          onPointerDown={many ? onDown : undefined} onPointerMove={many ? onMove : undefined} onPointerUp={many ? onUp : undefined} onPointerCancel={many ? onUp : undefined}
          onClickCapture={e => { if (swallow.current) { e.stopPropagation(); e.preventDefault() } }}
        >
          <ul>
            {clips.map((c, i) => {
              const d = i - cur, n = Math.min(3, Math.abs(d)), isFront = d === 0
              const style = { '--d': d, '--s': SCALE[n], '--dim': DIM[n], '--o': OP[n], '--z': 10 - n, '--k': n, '--ar': ratio[i] ?? 0.5625, ...(dragX !== null ? { '--drag': `${dragX}px` } : {}) } as React.CSSProperties
              return (
                <li key={c.src} className={s.item} data-d={d} style={style} aria-hidden={n > 2 || undefined}>
                  <button
                    type="button" className={s.card} tabIndex={n > 2 ? -1 : 0}
                    aria-label={isFront ? `Play ${c.name} with sound` : `Show ${c.name}`}
                    onClick={() => { if (!isFront) go(i); else setLive(true) }}
                  >
                    <ClipVideo src={c.src} front={isFront} live={isFront && live} attach={isFront && playing === i} onRatio={r => setRatio(p => (p[i] === r ? p : { ...p, [i]: r }))} />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        <div className={`${s.caption} ${s.first}`} key={cur}>
          <p className={s.name}>{many && <b>{two(cur + 1)}</b>}<span>{many ? front.name : ''}</span></p>
          <div className={s.actions}>
            {dl && <a className={s.cta} href={dl.url} download><Download aria-hidden="true" strokeWidth={2} />Download</a>}
            {dl && <p className={s.meta}>{size(dl.size_bytes)}</p>}
            {others.map(f => <a key={f.url} className={s.quiet} href={f.url} download>{f.name} · {size(f.size_bytes)}</a>)}
          </div>
        </div>
      </section>
    </main>
  )
}

/** Poster frame first (metadata only); the front card starts a muted loop after first paint, a tap plays it with sound. */
function ClipVideo({ src, front, live, attach, onRatio }: { src: string; front: boolean; live: boolean; attach: boolean; onRatio: (r: number) => void }) {
  const ref = React.useRef<HTMLVideoElement>(null)
  React.useEffect(() => {
    const v = ref.current; if (!v) return
    if (live) { v.muted = false; v.loop = false; v.controls = true; v.currentTime = 0; v.play().catch(() => {}) }
    else { v.controls = false; v.muted = true; v.loop = true; if (front && attach) v.play().catch(() => {}); else v.pause() }
  }, [live, front, attach])
  return (
    <video
      ref={ref} src={`${src}${src.includes('#') ? '' : '#t=0.1'}`} muted loop playsInline preload="metadata" aria-hidden="true"
      onLoadedMetadata={e => { const { videoWidth: w, videoHeight: h } = e.currentTarget; if (w && h) onRatio(w / h) }}
    />
  )
}
