'use client'

import * as React from 'react'
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Loader2, MapPin, Mic, Send, Square, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { containedRect } from '@/lib/ink'
import { pinDrawing, pinOf } from '@/lib/static-pin'
import { dictate as dictateApi, type DictationResult } from '@/lib/agents'
import { startMicRecording, type ActiveRecording, type StartRecording } from '@/lib/recorder'
import { dictationMessage } from './flow-view'
import { LevelMeter } from './level-meter'

export interface StaticFile { id: string; name: string }
export interface StaticComment {
  id: string
  body: string
  parent_id?: string | null
  author?: { name?: string | null } | null
  guest_author?: { name?: string | null } | null
  annotation?: { drawing_data?: unknown } | null
}

export interface StaticReviewProps {
  files: StaticFile[]
  startId: string
  canComment: boolean
  loadImage: (id: string) => Promise<string>
  loadComments: (id: string) => Promise<StaticComment[]>
  postComment: (id: string, body: string, drawing: Record<string, unknown> | null) => Promise<void>
  onExit?: () => void
  exitLabel?: string
  /** Approve is offered only when these are given (share links with approve permission). */
  approvedIds?: Set<string>
  onApprove?: (id: string) => Promise<void>
  onUnapprove?: (id: string) => Promise<void>
  /** Bump to re-read the comments (a note that waited for the reviewer's name was sent). */
  refreshToken?: number
  /** Voice memo: Talk records, this turns the audio into the note's words. Defaults to the signed-in dictation. */
  dictate?: (audio: Blob) => Promise<DictationResult>
  startRecording?: StartRecording
}

const NEIGHBOURS = [1, -1, 2, -2]
const SWIPE_PX = 48
/** Blue pins, white ring, soft shadow: the same on every picture. */
const PIN = 'oklch(0.62 0.19 255)'

const whoWrote = (c: StaticComment) => c.author?.name || c.guest_author?.name || 'Reviewer'

/** One ad at a time, fitted to the screen. Arrow keys and swipes move through the set; a tap pins a note to a spot. */
export function StaticReview(p: StaticReviewProps) {
  const [index, setIndex] = React.useState(() => Math.max(0, p.files.findIndex(f => f.id === p.startId)))
  const file = p.files[index]
  const total = p.files.length

  // ── Pictures: the current one, then two each way, already in the browser cache ──
  const urls = React.useRef(new Map<string, Promise<string>>())
  const resolved = React.useRef(new Map<string, string>())
  const [, redraw] = React.useReducer((n: number) => n + 1, 0)
  const [failed, setFailed] = React.useState<string | null>(null)
  const [natural, setNatural] = React.useState<Record<string, [number, number]>>({})
  const remember = (id: string, w: number, h: number) => { if (w && h) setNatural(m => (m[id]?.[0] === w && m[id]?.[1] === h ? m : { ...m, [id]: [w, h] })) }
  /** Loads a picture once; the preloaded copy also tells us its shape, so a switch already knows how to fit it. */
  const warm = React.useCallback((id: string) => {
    let hit = urls.current.get(id)
    if (!hit) {
      hit = p.loadImage(id)
      hit.catch(() => urls.current.delete(id))
      urls.current.set(id, hit)
      void hit.then(url => {
        resolved.current.set(id, url)
        redraw()
        const img = new Image()
        img.onload = () => remember(id, img.naturalWidth, img.naturalHeight)
        img.src = url
      }).catch(() => {})
    }
    return hit
  }, [p.loadImage]) // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (!file) return
    setFailed(null)
    warm(file.id).catch(() => setFailed(file.id))
    for (const d of NEIGHBOURS) { const n = p.files[index + d]; if (n) void warm(n.id).catch(() => {}) }
  }, [index, file?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Notes of this picture only ──
  const [notes, setNotes] = React.useState<StaticComment[] | null>(null)
  const [reload, setReload] = React.useState(0)
  React.useEffect(() => {
    if (!file) return
    let live = true
    setNotes(null)
    p.loadComments(file.id).then(c => { if (live) setNotes(c.filter(x => !x.parent_id)) }).catch(() => { if (live) setNotes([]) })
    return () => { live = false }
  }, [file?.id, reload, p.refreshToken]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Moving between pictures ──
  const [pending, setPending] = React.useState<[number, number] | null>(null)
  const [focused, setFocused] = React.useState<string | null>(null)
  const [text, setText] = React.useState('')
  const [error, setError] = React.useState('')
  const go = React.useCallback((d: number) => {
    setIndex(i => {
      const next = Math.min(total - 1, Math.max(0, i + d))
      if (next !== i) { if (!recRef.current) setPending(null); setFocused(null); setError('') }
      return next
    })
  }, [total])
  React.useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
      else if (e.key === 'Escape' && p.onExit) p.onExit()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [go, p.onExit]) // eslint-disable-line react-hooks/exhaustive-deps
  const touch = React.useRef<{ x: number; y: number } | null>(null)

  // ── Fit: the picture letterboxes, never crops; pins are measured against the picture, not the stage ──
  const stage = React.useRef<HTMLDivElement>(null)
  const [box, setBox] = React.useState({ w: 0, h: 0 })
  React.useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const [nw, nh] = (file && natural[file.id]) || [1, 1]
  const fit = containedRect(box.w, box.h, nw, nh)

  const place = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!p.canComment) return
    const r = e.currentTarget.getBoundingClientRect()
    setPending([(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height])
    setFocused(null)
  }

  const [sending, setSending] = React.useState(false)
  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    const body = text.trim()
    if (!body || !file || sending) return
    setSending(true); setError('')
    try {
      await p.postComment(file.id, body, pending ? pinDrawing(pending[0], pending[1]) : null)
      setText(''); setPending(null)
      setReload(n => n + 1)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'That did not send. Try again.')
    } finally { setSending(false) }
  }

  const [approving, setApproving] = React.useState(false)
  const approved = !!file && !!p.approvedIds?.has(file.id)
  const toggleApprove = async () => {
    if (!file || !p.onApprove || approving) return
    setApproving(true); setError('')
    try { await (approved ? p.onUnapprove?.(file.id) : p.onApprove(file.id)) }
    catch (err) { if ((err as Error)?.message !== 'identity') setError(approved ? 'Could not undo. Try again.' : 'Could not approve. Try again.') }
    finally { setApproving(false) }
  }

  // ── Voice memo: Talk records; a tap on the image while recording sets the pin; the words become the note ──
  const dictate = p.dictate ?? dictateApi
  const start = p.startRecording ?? startMicRecording
  const [rec, setRec] = React.useState<{ rec: ActiveRecording; startedAt: number; fileId: string } | null>(null)
  const [elapsed, setElapsed] = React.useState(0)
  const [transcribing, setTranscribing] = React.useState(false)
  const [memoMsg, setMemoMsg] = React.useState('')
  const level = React.useRef(0)
  const pendingRef = React.useRef(pending)
  pendingRef.current = pending
  React.useEffect(() => {
    if (!rec) { setElapsed(0); return }
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - rec.startedAt) / 1000)), 500)
    return () => clearInterval(id)
  }, [rec])
  React.useEffect(() => () => { recRef.current?.rec.cancel() }, [])
  const recRef = React.useRef(rec)
  recRef.current = rec
  const [memo, setMemo] = React.useState<{ state: 'saving' | 'saved' | 'failed'; fileId: string; words: string; pin: [number, number] | null } | null>(null)
  /** The memo goes out on its own, to the image it was recorded on, with the pin if one was set (as on video). */
  const saveMemo = async (m: { fileId: string; words: string; pin: [number, number] | null }) => {
    setMemo({ ...m, state: 'saving' })
    try {
      await p.postComment(m.fileId, m.words, m.pin ? pinDrawing(m.pin[0], m.pin[1]) : null)
      setMemo({ ...m, state: 'saved' })
      setReload(n => n + 1)
      setTimeout(() => setMemo(cur => (cur?.state === 'saved' && cur.words === m.words ? null : cur)), 3000)
    } catch { setMemo({ ...m, state: 'failed' }) }
  }
  const talk = async () => {
    setMemoMsg(''); setError(''); setMemo(null)
    if (rec) {
      const { rec: r, fileId } = rec
      const pin = pendingRef.current
      setRec(null); setTranscribing(true)
      try {
        const out = await dictate(await r.stop())
        const words = out.text.trim()
        if (!words) { setMemoMsg('Nothing was heard. Try again or type it.'); return }
        if (fileId === currentIdRef.current) setPending(null)
        await saveMemo({ fileId, words, pin })
      } catch (e) { setMemoMsg(dictationMessage(e)) }
      finally { setTranscribing(false) }
      return
    }
    try {
      level.current = 0
      const r = await start(v => { level.current = v })
      setRec({ rec: r, startedAt: Date.now(), fileId: file!.id })
    } catch (e) {
      const denied = (e as Error)?.name === 'NotAllowedError' || (e as Error)?.name === 'SecurityError'
      setMemoMsg(denied ? 'Microphone is blocked. Allow it in the browser, or type your note.' : 'Microphone unavailable. Type your note instead.')
    }
  }
  const cancelTalk = () => { rec?.rec.cancel(); setRec(null); setPending(null) }
  const currentIdRef = React.useRef(file?.id)
  currentIdRef.current = file?.id

  if (!file) return <div className="grid h-dvh place-items-center bg-bg-primary text-sm text-text-secondary">No images to review.</div>

  const pinned = (notes ?? []).map(c => ({ c, at: pinOf(c.annotation?.drawing_data) })).filter(x => x.at)
  const numberOf = (id: string) => pinned.findIndex(x => x.c.id === id) + 1
  const url = resolved.current.get(file.id)
  const navBtn = 'press grid h-11 w-11 place-items-center rounded-full border border-white/20 bg-black/55 text-white shadow-[0_6px_18px_-6px_rgba(0,0,0,.7)] backdrop-blur-md hover:bg-black/70 disabled:pointer-events-none disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white'

  return (
    <div className="flex h-dvh flex-col bg-bg-primary text-text-primary md:flex-row" data-testid="static-review" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Image review">
        <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border bg-bg-secondary pl-1 pr-3">
          {p.onExit && <button type="button" onClick={p.onExit} aria-label={p.exitLabel ?? 'Back'} className="press grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-secondary hover:bg-bg-hover hover:text-text-primary"><ArrowLeft size={18} /></button>}
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold" title={file.name}>{file.name}</h1>
          <span aria-live="polite" data-testid="static-counter" className="shrink-0 rounded-full bg-bg-tertiary px-3 py-1 font-mono text-[13px] tabular-nums text-text-secondary">{index + 1} / {total}</span>
        </header>

        <div
          data-testid="static-stage"
          className="relative min-h-0 flex-1 select-none overflow-hidden bg-[oklch(0.16_0_0)]"
          onTouchStart={e => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY } }}
          onTouchEnd={e => {
            const s = touch.current; touch.current = null
            const t = e.changedTouches[0]
            if (!s || !t) return
            const dx = t.clientX - s.x, dy = t.clientY - s.y
            if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1)
          }}
        >
          {rec && <div className="flow-rec-glow" data-testid="rec-glow" aria-hidden="true" />}
          {/* Padding lives on the outside: the measured box is exactly the room the picture may use. */}
          <div className="absolute inset-0 p-3 md:p-6">
          <div ref={stage} className="flex h-full w-full items-center justify-center">
            {failed === file.id ? (
              <p role="alert" className="text-sm text-white/70">This image could not be loaded.</p>
            ) : !url ? (
              <Loader2 className="animate-spin text-white/60 motion-reduce:animate-none" size={28} aria-label="Loading image" />
            ) : (
              <div
                key={file.id}
                data-testid="static-frame"
                onClick={place}
                className={cn('relative shrink-0 rounded-[2px] shadow-[0_20px_60px_-20px_rgba(0,0,0,.8)]', p.canComment && 'cursor-crosshair')}
                style={{ width: fit.width, height: fit.height }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={file.name}
                  draggable={false}
                  onLoad={e => remember(file.id, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
                  className="h-full w-full object-contain"
                />
                {pinned.map(({ c, at }) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={e => { e.stopPropagation(); setFocused(f => (f === c.id ? null : c.id)); setPending(null) }}
                    aria-label={`Note ${numberOf(c.id)}: ${c.body}`}
                    className={cn('absolute grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white text-[12px] font-bold text-white transition-transform duration-150 ease-out motion-reduce:transition-none', focused === c.id ? 'z-10 scale-125' : 'hover:scale-110')}
                    style={{ left: `${at![0] * 100}%`, top: `${at![1] * 100}%`, background: PIN, boxShadow: '0 3px 10px rgba(0,0,0,.45), 0 0 0 1px rgba(0,0,0,.15)' }}
                  >{numberOf(c.id)}</button>
                ))}
                {pending && (!rec || rec.fileId === file.id) && (
                  <span aria-hidden="true" data-testid="pending-pin" className="pointer-events-none absolute z-10 h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white" style={{ left: `${pending[0] * 100}%`, top: `${pending[1] * 100}%`, background: `color-mix(in oklab, ${PIN} 35%, transparent)`, boxShadow: '0 3px 10px rgba(0,0,0,.45)' }} />
                )}
              </div>
            )}
          </div>
          </div>
          <button type="button" onClick={() => go(-1)} disabled={index === 0} aria-label="Previous image" className={cn(navBtn, 'absolute left-3 top-1/2 -translate-y-1/2')}><ChevronLeft size={22} /></button>
          <button type="button" onClick={() => go(1)} disabled={index === total - 1} aria-label="Next image" className={cn(navBtn, 'absolute right-3 top-1/2 -translate-y-1/2')}><ChevronRight size={22} /></button>
        </div>
      </section>

      <aside aria-label="Feedback" className="flex h-[38dvh] min-h-0 shrink-0 flex-col border-t border-border bg-bg-secondary md:h-auto md:w-[340px] md:border-l md:border-t-0">
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
          <p className="text-sm font-semibold">Feedback{notes && notes.length > 0 && <span className="ml-1.5 tabular-nums text-text-tertiary">{notes.length}</span>}</p>
          {p.onApprove && (
            <button type="button" onClick={toggleApprove} disabled={approving} aria-pressed={approved}
              className={cn('press inline-flex h-11 items-center gap-1.5 rounded-full px-4 text-sm font-semibold disabled:opacity-60', approved ? 'bg-status-success/15 text-status-success' : 'border border-border text-text-primary hover:bg-bg-hover')}>
              {approving ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" /> : <Check size={15} aria-hidden="true" />}{approved ? 'Approved' : 'Approve'}
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {notes === null ? (
            <p role="status" className="py-6 text-center text-sm text-text-tertiary">Loading notes…</p>
          ) : notes.length === 0 ? (
            <p className="mx-auto max-w-[240px] py-8 text-center text-sm leading-relaxed text-text-tertiary">{p.canComment ? <>No notes on this ad yet. <span className="font-semibold text-text-secondary">Tap the image</span> to pin one to a spot, or just type.</> : 'No notes on this ad.'}</p>
          ) : (
            <ul className="space-y-2">
              {notes.map(c => {
                const n = numberOf(c.id)
                return (
                  <li key={c.id}>
                    <button type="button" onClick={() => setFocused(f => (f === c.id ? null : c.id))} aria-pressed={focused === c.id}
                      className={cn('press flex w-full items-start gap-3 rounded-xl border p-3 text-left', focused === c.id ? 'border-text-tertiary bg-bg-hover' : 'border-border bg-bg-primary hover:bg-bg-hover')}>
                      {n > 0
                        ? <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 border-white text-[11px] font-bold text-white" style={{ background: PIN, boxShadow: '0 2px 6px rgba(0,0,0,.35)' }}>{n}</span>
                        : <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-bg-tertiary text-text-tertiary" title="Whole image"><MapPin size={12} aria-hidden="true" /></span>}
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium text-text-tertiary">{whoWrote(c)}</span>
                        <span className="mt-0.5 block whitespace-pre-wrap break-words text-[15px] leading-snug text-text-primary">{c.body}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {error && <p role="alert" className="shrink-0 px-4 pb-1 text-sm text-status-error">{error}</p>}
        {p.canComment ? (
          <form onSubmit={send} className="shrink-0 border-t border-border p-3" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
            {pending && (
              <p className="mb-2 flex items-center gap-2 text-xs text-text-secondary">
                <span className="inline-block h-3 w-3 rounded-full border-2 border-white" style={{ background: PIN, boxShadow: '0 1px 4px rgba(0,0,0,.4)' }} aria-hidden="true" />
                Pinned to a spot on the image
                <button type="button" onClick={() => setPending(null)} aria-label="Remove pin" className="press -my-2 ml-auto grid h-11 w-11 place-items-center rounded-full text-text-secondary hover:bg-bg-hover"><X size={14} /></button>
              </p>
            )}
            <div className="rounded-2xl border border-border bg-bg-primary p-1.5 focus-within:border-text-tertiary">
              {rec ? (
                <div className="flex h-11 min-w-0 items-center gap-2 px-1" role="status" aria-label="Recording">
                  <LevelMeter levelRef={level} />
                  <span data-testid="rec-timer" className="min-w-[3rem] text-right font-mono text-sm font-semibold tabular-nums">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
                  <button type="button" onClick={cancelTalk} aria-label="Cancel recording" className="press grid h-11 w-11 shrink-0 place-items-center rounded-xl text-text-secondary hover:bg-bg-hover"><X size={18} /></button>
                </div>
              ) : transcribing ? (
                <p role="status" className="flex h-11 min-w-0 items-center gap-2 px-2 text-sm text-text-secondary"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" />Transcribing…</p>
              ) : (
                <textarea value={text} onChange={e => setText(e.target.value)} rows={2} aria-label="Write a note on this image"
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(e) } }}
                  placeholder={pending ? 'What should change here?' : 'Write a note, or tap the image to pin it…'}
                  className="max-h-32 min-h-11 block w-full min-w-0 resize-none bg-transparent px-2 py-2.5 text-base text-text-primary outline-none placeholder:text-text-tertiary focus:outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none" />
              )}
              <div className="flex items-center justify-between gap-2 pt-1">
              <button type="button" onClick={talk} disabled={transcribing} aria-label={rec ? 'Stop recording' : 'Talk'} title={rec ? 'Stop (the words become your note)' : 'Talk: say what to change'}
                className="flow-comment inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl px-3.5 text-sm font-semibold text-text-inverse disabled:opacity-40">
                {rec ? <><Square size={16} aria-hidden="true" />Stop</> : <><Mic size={18} aria-hidden="true" />Talk</>}
              </button>
              <button type="submit" disabled={!text.trim() || sending || !!rec || transcribing} aria-label="Send note"
                className="flow-comment inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl px-4 text-sm font-semibold text-text-inverse disabled:opacity-40">
                {sending ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" /> : <Send size={16} aria-hidden="true" />}Send
              </button>
              </div>
            </div>
            {memo && (
              <p role={memo.state === 'failed' ? 'alert' : 'status'} data-testid="memo-status" data-state={memo.state} className={cn('mt-2 flex items-center gap-2 text-xs', memo.state === 'failed' ? 'text-status-error' : memo.state === 'saved' ? 'text-status-success' : 'text-text-secondary')}>
                {memo.state === 'saving' && <><Loader2 size={13} className="animate-spin motion-reduce:animate-none" />Saving your memo…</>}
                {memo.state === 'saved' && <><Check size={14} aria-hidden="true" />Memo saved</>}
                {memo.state === 'failed' && <>Could not save your memo.<button type="button" onClick={() => void saveMemo(memo)} className="press inline-flex min-h-11 items-center font-semibold underline">Retry</button></>}
              </p>
            )}
            {memoMsg && <p role="alert" className="mt-2 text-xs text-text-secondary">{memoMsg}</p>}
          </form>
        ) : <p className="shrink-0 border-t border-border py-3 text-center text-sm text-text-secondary">View-only access. Comments are disabled.</p>}
      </aside>
    </div>
  )
}
