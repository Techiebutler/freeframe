'use client'

import * as React from 'react'
import { Check, Loader2, Mic, Pencil, RotateCcw, Send, Square, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timecode } from '@/lib/platform'
import { dictate as dictateApi, type DictationResult } from '@/lib/agents'
import { notesFromDictation, notesReducer, sendBlocked, sendable, type FlowNote } from '@/lib/flow-notes'
import { buildDrawingData, type InkMark } from '@/lib/ink'
import { InkLayer, type InkReplay } from './ink-layer'
import { trackVideo, videoTimeAt, type TimelinePoint } from '@/lib/rec-timeline'
import { startMicRecording, type ActiveRecording, type StartRecording } from '@/lib/recorder'

export interface FlowFile { id: string; name: string; thumbnail_url?: string | null; version?: number | null }

export interface FlowViewProps {
  /** The existing media viewer; `overlay` (the ink layer) must be mounted inside the video frame. Never cropped: it letterboxes. */
  renderMedia: (overlay: React.ReactNode) => React.ReactNode
  files: FlowFile[]
  currentFileId: string
  onSelectFile: (id: string) => void
  getPlayhead: () => number
  onPause: () => void
  onSeek: (t: number) => void
  canComment: boolean
  /** Posts every note as a comment. Rejects to keep the notes on screen. */
  onSendNotes: (notes: { text: string; t: number; annotation: Record<string, unknown> | null }[]) => Promise<void>
  onApprove: () => Promise<void> | void
  approved: boolean
  /** Share links without approve permission: with no notes the right-hand button stays disabled. Default true. */
  canApprove?: boolean
  onExit?: () => void
  exitLabel?: string
  dictate?: (audio: Blob) => Promise<DictationResult>
  startRecording?: StartRecording
}

let seq = 0
const newId = () => `note-${Date.now()}-${seq++}`

const stamp = (t: number) => `${timecode(t)}.${Math.floor((t % 1) * 10)}`

function dictationMessage(e: unknown): string {
  const detail = (e as { detail?: string })?.detail
  return detail === 'dictation_unavailable' ? 'Dictation is not set up. Type your note instead.' : 'Could not transcribe. Try again or type it.'
}

export function FlowView(p: FlowViewProps) {
  const dictate = p.dictate ?? dictateApi
  const start = p.startRecording ?? startMicRecording
  const [notes, dispatch] = React.useReducer(notesReducer, [] as FlowNote[])
  const [active, setActive] = React.useState<{ id: string; rec: ActiveRecording; startedAt: number } | null>(null)
  const [elapsed, setElapsed] = React.useState(0)
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState('')
  const [messages, setMessages] = React.useState<Record<string, string>>({})
  const marks = React.useRef<InkMark[]>([])
  const [replay, setReplay] = React.useState<InkReplay | null>(null)
  const replayKey = React.useRef(0)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = React.useState(false)
  // Media events do not bubble, but they can be caught on the way down: follow whichever <video> the player mounts.
  React.useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const on = (e: Event) => { if (e.target instanceof HTMLVideoElement) setPlaying(!e.target.paused && !e.target.ended) }
    const events = ['play', 'playing', 'pause', 'ended', 'seeking'] as const
    events.forEach(ev => root.addEventListener(ev, on, true))
    return () => events.forEach(ev => root.removeEventListener(ev, on, true))
  }, [])
  const tracker = React.useRef<ReturnType<typeof trackVideo> | null>(null)
  /** What the video did during each note's recording; kept so Try again maps times the same way. */
  const timelines = React.useRef(new Map<string, TimelinePoint[]>())

  React.useEffect(() => {
    if (!active) { setElapsed(0); return }
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - active.startedAt) / 1000)), 500)
    return () => clearInterval(id)
  }, [active])

  const transcribe = async (n: { id: string; t: number; marks?: InkMark[] }, audio: Blob) => {
    const { id } = n
    dispatch({ type: 'transcribing', id, audio })
    setMessages(m => { const { [id]: _, ...rest } = m; return rest })
    try {
      const r = await dictate(audio)
      // One note per spoken sentence, each with the ink drawn while it was said (H69)
      const points = timelines.current.get(id) ?? []
      const timeAt = points.length ? (ms: number) => videoTimeAt(points, ms) : (ms: number) => Math.round((n.t + ms / 1000) * 1000) / 1000
      const parts = notesFromDictation(timeAt, r.text, r.segments ?? [], n.marks ?? [])
      dispatch({ type: 'split', id, parts: parts.map((part, i) => ({ ...part, id: i === 0 ? id : newId() })) })
    }
    catch (e) { dispatch({ type: 'failed', id }); setMessages(m => ({ ...m, [id]: dictationMessage(e) })) }
  }

  const tapComment = async () => {
    setError('')
    if (active) {
      const { id, rec } = active
      setActive(null)
      const drawn = marks.current
      marks.current = []
      tracker.current?.stop()
      timelines.current.set(id, tracker.current?.points ?? [])
      tracker.current = null
      dispatch({ type: 'marks', id, marks: drawn })
      const note = notes.find(n => n.id === id)
      await transcribe({ id, t: note?.t ?? p.getPlayhead(), marks: drawn }, await rec.stop())
      return
    }
    // The video keeps playing: talk and draw while it runs (H69).
    const id = newId()
    marks.current = []
    dispatch({ type: 'add', id, t: p.getPlayhead() })
    try {
      const rec = await start()
      const startedAt = Date.now()
      tracker.current = trackVideo(rootRef.current?.querySelector('video') ?? null, startedAt)
      setActive({ id, rec, startedAt })
    }
    catch {
      dispatch({ type: 'failed', id })
      setMessages(m => ({ ...m, [id]: 'Microphone unavailable. Type your note instead.' }))
    }
  }

  const ready = sendable(notes)
  const blocked = sendBlocked(notes)
  const send = async () => {
    setSending(true); setError('')
    try {
      if (!notes.length) { await p.onApprove(); return }
      await p.onSendNotes(ready.map(n => ({ text: n.text.trim(), t: n.t, annotation: buildDrawingData(n.marks ?? []) })))
      dispatch({ type: 'clear' })
    } catch { setError('Could not send. Your notes are still here. Try again.') }
    finally { setSending(false) }
  }

  const canApprove = p.canApprove ?? true
  const sendLabel = notes.length ? `Send ${ready.length || ''}`.trim() : !canApprove ? 'Send' : p.approved ? 'Approved' : 'Approve'

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-bg-primary" style={{ paddingTop: 'env(safe-area-inset-top)' }} data-testid="flow-view">
      {/* The briefing's files */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-bg-secondary pl-2">
        <nav aria-label="Files in this briefing" className="min-w-0 flex-1">
          <ul className="flex gap-1 overflow-x-auto py-1">
            {p.files.map(f => (
              <li key={f.id} className="shrink-0">
                <button type="button" onClick={() => f.id !== p.currentFileId && p.onSelectFile(f.id)} aria-current={f.id === p.currentFileId ? 'true' : undefined}
                  className={cn('press min-h-11 max-w-[160px] truncate rounded-full px-4 text-sm font-medium', f.id === p.currentFileId ? 'bg-bg-hover text-text-primary ring-1 ring-text-tertiary' : 'text-text-secondary hover:bg-bg-hover')}>
                  {f.name}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {p.onExit && <button type="button" onClick={p.onExit} className="press min-h-11 shrink-0 px-3 text-sm font-medium text-text-secondary hover:text-text-primary">{p.exitLabel ?? 'Exit'}</button>}
      </div>

      {/* 9:16 at full height, letterboxed never cropped */}
      <div className="flex min-h-0 flex-1 flex-col" data-recording={active ? '' : undefined}>
        {p.renderMedia(
          <InkLayer
            active={!!active}
            playing={playing}
            onStart={p.onPause}
            replay={replay}
            onMark={(k, points) => { if (active) marks.current.push({ k, points, t: p.getPlayhead(), offset_ms: Date.now() - active.startedAt }) }}
          />,
        )}
      </div>

      {notes.length > 0 && (
        <ul aria-label="Your notes" className="max-h-[30dvh] shrink-0 space-y-2 overflow-y-auto border-t border-border bg-bg-secondary px-3 py-2">
          {notes.map(n => (
            <li key={n.id} className="flex items-start gap-2">
              <button type="button" onClick={() => p.onSeek(n.t)} aria-label={`Go to ${timecode(n.t)}`} className="press min-h-11 shrink-0 rounded-lg bg-bg-tertiary px-2.5 font-mono text-xs tabular-nums text-text-primary">{timecode(n.t)}</button>
              <div className="min-w-0 flex-1">
                {n.status === 'recording' && <p role="status" className="flex min-h-11 items-center text-sm text-text-secondary">Recording. Talk and draw on the picture, then tap Stop.</p>}
                {n.status === 'transcribing' && <p role="status" className="flex min-h-11 items-center gap-2 text-sm text-text-secondary"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" />Transcribing…</p>}
                {(n.status === 'ready' || n.status === 'failed') && (
                  <>
                    <textarea aria-label={`Note at ${timecode(n.t)}`} value={n.text} rows={2} onChange={e => dispatch({ type: 'edit', id: n.id, text: e.target.value })}
                      className="w-full resize-none rounded-lg border border-border bg-bg-primary px-3 py-2 text-base text-text-primary outline-none focus:border-text-tertiary" />
                    {!!n.marks?.length && (
                      <ul aria-label={`Drawings on the note at ${timecode(n.t)}`} className="mt-1 flex flex-wrap gap-1.5">
                        {n.marks.map((m, i) => (
                          <li key={i}>
                            <button type="button" onClick={() => { p.onSeek(m.t); setReplay({ key: ++replayKey.current, marks: [m] }) }}
                              aria-label={`Drawing at ${stamp(m.t)}`}
                              className="press inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border px-3 font-mono text-xs tabular-nums text-text-secondary hover:bg-bg-hover">
                              <Pencil size={12} aria-hidden="true" />{stamp(m.t)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {n.status === 'failed' && (
                      <p role="alert" className="flex flex-wrap items-center gap-x-3 text-xs text-text-secondary">
                        <span>{messages[n.id] ?? 'Could not transcribe.'}</span>
                        {n.audio && <button type="button" onClick={() => transcribe(n, n.audio!)} className="press inline-flex min-h-11 items-center gap-1 font-semibold text-text-primary"><RotateCcw size={12} />Try again</button>}
                      </p>
                    )}
                  </>
                )}
              </div>
              <button type="button" onClick={() => dispatch({ type: 'remove', id: n.id })} aria-label={`Delete note at ${timecode(n.t)}`} className="press grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-secondary hover:bg-bg-hover"><X size={16} /></button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="shrink-0 bg-bg-secondary px-4 py-2 text-sm text-status-error">{error}</p>}

      {/* One-hand bottom controls */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border bg-bg-secondary px-3 pt-2" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
        {p.canComment ? (
          <>
            <button type="button" onClick={tapComment}
              className="flow-comment inline-flex h-14 min-w-0 flex-1 items-center justify-center gap-2 rounded-full px-5 text-base font-semibold text-text-inverse">
              {active ? <><Square size={18} aria-hidden="true" />Stop · {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</> : <><Mic size={24} aria-hidden="true" />Comment</>}
            </button>
            <button type="button" onClick={send} disabled={sending || blocked || (!notes.length && (p.approved || !canApprove))}
              className="press inline-flex h-14 shrink-0 items-center justify-center gap-1.5 rounded-full border border-border px-4 text-sm font-semibold text-text-primary hover:bg-bg-hover disabled:opacity-50">
              {sending ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" /> : notes.length ? <Send size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{sendLabel}
            </button>
          </>
        ) : <p className="flex-1 py-3 text-center text-sm text-text-secondary">View-only access. Comments are disabled.</p>}
      </div>
    </div>
  )
}
