'use client'

import * as React from 'react'
import { Check, Clock, Keyboard, Link2, Loader2, Mic, Paperclip, RotateCcw, Send, Square, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timecode } from '@/lib/platform'
import { dictate as dictateApi, type DictationResult } from '@/lib/agents'
import { dictationPayload, notesFromDictation, notesReducer, sendBlocked, sendable, type FlowNote } from '@/lib/flow-notes'
import { drawnFrameFile, nearestShot, snapshotVideo, type FrameShot } from '@/lib/drawn-frame'
import { buildDrawingData, isInk, splitDeictic, type InkMark } from '@/lib/ink'
import { getNoteOutbox, useNoteOutbox, type NoteBody, type NotePayload } from '@/lib/note-outbox'
import { imagesFrom, IMAGE_TYPES, pickImages } from '@/lib/comment-images'
import type { Outbox } from '@/lib/outbox'
import { doneLine, markApproved, markFeedback, sentLine, sessionSummary, unmarkApproved } from '@/lib/flow-session'
import { Confetti } from './confetti'
import { EmbedBar, embedKey } from './embed-bar'
import { ModuleTabs } from '@/components/share/module-tabs'
import { markHandedOn, type DeliveryRef } from '@/lib/delivery'
import { InkLayer, type InkReplay } from './ink-layer'
import { LevelMeter } from './level-meter'
import { trackVideo, videoTimeAt, type TimelinePoint } from '@/lib/rec-timeline'
import { startMicRecording, type ActiveRecording, type StartRecording } from '@/lib/recorder'
import { dictInitial, dictStep, keepSegment, type DictEvent } from '@/lib/embed-dictation'

export interface FlowFile { id: string; name: string; thumbnail_url?: string | null; version?: number | null }

export interface FlowViewProps {
  /** The existing media viewer; `overlay` (the ink layer) must be mounted inside the video frame. Never cropped: it letterboxes. */
  renderMedia: (overlay: React.ReactNode, extra: { markers: { t: number; label: string }[] }) => React.ReactNode
  files: FlowFile[]
  currentFileId: string
  onSelectFile: (id: string) => void
  getPlayhead: () => number
  onPause: () => void
  onSeek: (t: number) => void
  canComment: boolean
  /** What a note needs to be saved from anywhere: every note is saved in the background as soon as it exists. */
  notePayload: (note: NoteBody) => NotePayload
  outbox?: Outbox
  /** False while the reviewer still has to say who they are; notes wait (nothing is lost) and onNeedSave is called. */
  canSave?: boolean
  onNeedSave?: () => void
  /** Closes the feedback round (Send to agent). Without it the button reads Done: the notes are already saved. */
  onFinishRound?: () => Promise<void>
  /** Notes sent (share links): tells the server the round is done, so a waiting agent starts now. */
  onSent?: () => void
  finishLabel?: string
  /** May hand back the delivery page the approval created: Approve then bursts confetti and offers one main action, Copy share link. */
  onApprove: () => Promise<DeliveryRef | null | void> | DeliveryRef | null | void
  /** Takes the approval back (offered for 5 s after approving). Without it Approve is final and moves on quickly. */
  onUndoApprove?: () => Promise<void>
  /** Another file waits after this one; onNext opens it. */
  hasNext?: boolean
  onNext?: () => void
  /** Scopes the closing numbers ("7 approved, 3 with feedback") to this folder or share. */
  sessionKey?: string
  approved: boolean
  /** The briefing's parts (Hook 1, Body, CTA...): the share link exists only when all are approved, so until then the row says how far it is. */
  parts?: { approved: number; total: number }
  /** Comments of every part that no Send has closed yet: while there are any, Send feedback is the primary action and Approve a quiet per-part one. */
  unsentFeedback?: number
  /** Share links without approve permission: with no notes the right-hand button stays disabled. Default true. */
  canApprove?: boolean
  onExit?: () => void
  exitLabel?: string
  /** Left of the file tabs: the caller's way out (back to the folder) and download. */
  lead?: React.ReactNode
  dictate?: (audio: Blob) => Promise<DictationResult>
  startRecording?: StartRecording
  /** Desktop: video left, notes in a right-hand column, talk/type bar under the video (Flask). */
  wide?: boolean
  /** Iframe mode (share ?embed=1): only the video, with Comment and Send/Approve floating over its top edge. No files bar, no notes list. */
  embed?: boolean
  /** A note reached the server (embed: tells the parent page). */
  onNoteSaved?: (t: number) => void
  /** Embed: true while a note is recording, transcribing or still uploading (leaving the page then must not close the round). */
  onBusy?: (busy: boolean) => void
  /** Embed only: the folder stepper, shown under the Comment row while not recording. */
  embedNav?: React.ReactNode
  /** Embed only: AutoReview's comment list; `show` goes to a comment's time and plays its drawing on the video. */
  embedComments?: (show: (t: number, drawing: unknown) => void) => React.ReactNode
  /** Embed only: comment times for the player's markers (default: this session's notes). */
  embedMarkers?: number[]
}

let seq = 0
const newId = () => `note-${Date.now()}-${seq++}`
/** A UUID: the API keeps one dictation row for all the sentence-notes that share it. */
const newDictationId = (): string => globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16))

const stamp = (t: number) => `${timecode(t)}.${Math.floor((t % 1) * 10)}`

/** Clock (waiting) -> spinner (sending) -> check (saved); red Retry when it failed. Never colour alone: each has its own glyph and name. */
function NoteStatus({ status, onRetry, onDelete, onSendWithout, label }: { status?: string; onRetry: () => void; onDelete?: () => void; onSendWithout?: () => void; label: string }) {
  if (status === 'queued') return <span role="img" aria-label="Waiting to send" className="grid h-11 w-11 shrink-0 place-items-center text-text-tertiary"><Clock size={16} /></span>
  if (status === 'sending') return <span role="img" aria-label="Sending" className="grid h-11 w-11 shrink-0 place-items-center text-text-secondary"><Loader2 size={16} className="animate-spin motion-reduce:animate-none" /></span>
  if (status === 'saved') return <span role="img" aria-label="Saved" className="grid h-11 w-11 shrink-0 place-items-center text-status-success"><Check size={18} /></span>
  if (status === 'failed') return (
    <span className="flex shrink-0 flex-col items-end">
      <button type="button" onClick={onRetry} aria-label={`Retry sending note at ${label}`} className="press inline-flex h-11 shrink-0 items-center gap-1 rounded-full px-3 text-xs font-semibold text-status-error hover:bg-bg-hover"><RotateCcw size={13} />Retry</button>
      {/* An image that will not upload must never strand the comment: the author may send it without. */}
      {onSendWithout && <button type="button" onClick={onSendWithout} aria-label={`Send note at ${label} without its images`} className="press inline-flex min-h-11 items-center rounded-full px-3 text-xs font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary">Send without image</button>}
    </span>
  )
  return onDelete ? <button type="button" onClick={onDelete} aria-label={`Delete note at ${label}`} className="press grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-secondary hover:bg-bg-hover"><X size={16} /></button> : <span className="h-11 w-11 shrink-0" />
}

/** The drawing as a small picture: the strokes in the same 0..1 frame, on a 9:16 card. */
/** A reference image waiting to go out with the comment (or already in a note). */
function ImageThumb({ file, onRemove, small }: { file: File; onRemove?: () => void; small?: boolean }) {
  const [url, setUrl] = React.useState<string>()
  React.useEffect(() => { const u = URL.createObjectURL(file); setUrl(u); return () => URL.revokeObjectURL(u) }, [file])
  const size = small ? 'h-10 w-10' : 'h-14 w-14'
  return (
    <span className={`relative inline-block shrink-0 overflow-hidden rounded-lg border border-border bg-bg-tertiary ${size}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a local blob preview, nothing to optimise */}
      {url && <img src={url} alt={file.name || 'Reference image'} className="h-full w-full object-cover" />}
      {onRemove && <button type="button" onClick={onRemove} aria-label={`Remove ${file.name || 'image'}`}
        className="press absolute right-0.5 top-0.5 grid h-6 w-6 place-items-center rounded-full bg-black/70 text-white"><X size={12} /></button>}
    </span>
  )
}

function InkThumb({ mark }: { mark: InkMark }) {
  return (
    <svg viewBox="0 0 1 1" preserveAspectRatio="none" width="18" height="32" aria-hidden="true" className="shrink-0 rounded-[4px] bg-bg-tertiary ring-1 ring-border">
      {mark.k === 'dot'
        ? <circle cx={mark.points[0][0]} cy={mark.points[0][1]} r="0.12" fill="none" stroke="currentColor" strokeWidth="0.06" className="text-text-primary" />
        : <polyline points={mark.points.map(q => q.join(',')).join(' ')} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" className="text-text-primary" />}
    </svg>
  )
}

/** A tab names what differs between the files ("Hook 3"), not the concept they share; the full name stays as the tooltip. */
export function tabLabels(names: string[]): string[] {
  if (names.length < 2) return names
  const shared = names.reduce((a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, i) })
  const cut = Math.max(...[' - ', ' – ', ' — ', ': ', ' | '].map(sep => { const i = shared.lastIndexOf(sep); return i < 0 ? -1 : i + sep.length })) // only at a separator, never mid-word
  return cut < 0 ? names : names.map(x => x.slice(cut).trim() || x)
}

export function dictationMessage(e: unknown): string {
  const detail = (e as { detail?: string })?.detail
  return detail === 'dictation_unavailable' ? 'Dictation is not set up. Type your note instead.' : 'Could not transcribe. Try again or type it.'
}

/** Embed layout: a column beside the video when the frame has the room for it (the video keeps its own ratio), else below. */
export const SIDE_MIN = 200
export function useEmbedSide(root: React.RefObject<HTMLElement | null>, on: boolean) {
  const [state, setState] = React.useState({ side: false, ratio: 9 / 16 })
  React.useEffect(() => {
    const el = root.current
    if (!on || !el) return
    let ratio = 9 / 16
    const measure = () => {
      const { width, height } = el.getBoundingClientRect()
      const side = height > 0 && width - height * ratio >= SIDE_MIN
      setState(prev => (prev.side === side && prev.ratio === ratio ? prev : { side, ratio }))
    }
    const meta = (e: Event) => {
      if (e.target instanceof HTMLVideoElement && e.target.videoWidth && e.target.videoHeight) { ratio = Math.min(3, Math.max(0.3, e.target.videoWidth / e.target.videoHeight)); measure() }
    }
    el.addEventListener('loadedmetadata', meta, true)
    const v = el.querySelector('video')
    if (v?.videoWidth && v.videoHeight) ratio = Math.min(3, Math.max(0.3, v.videoWidth / v.videoHeight))
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => { el.removeEventListener('loadedmetadata', meta, true); ro?.disconnect() }
  }, [root, on])
  return state
}

export function FlowView(p: FlowViewProps) {
  const dictate = p.dictate ?? dictateApi
  const start = p.startRecording ?? startMicRecording
  const [notes, dispatch] = React.useReducer(notesReducer, [] as FlowNote[])
  const [active, setActiveState] = React.useState<{ id: string; t: number; rec: ActiveRecording; startedAt: number } | null>(null)
  // The ref changes in the same tick as the state: a Play right after a start must still find the recording to close.
  const activeRef = React.useRef<typeof active>(null)
  const setActive = (a: typeof active) => { activeRef.current = a; setActiveState(a) }
  const [elapsed, setElapsed] = React.useState(0)
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState('')
  const [typed, setTyped] = React.useState('')
  const [images, setImages] = React.useState<File[]>([])
  const [imageNote, setImageNote] = React.useState<string | null>(null)
  const filePick = React.useRef<HTMLInputElement>(null)
  const addImages = (files: File[]) => { if (!files.length) return; const r = pickImages(images, files); setImages(r.images); setImageNote(r.skipped) }
  const typedRef = React.useRef<HTMLInputElement>(null)
  // Drop anywhere (spec 2026-11-16): the whole review takes a dragged file; the browser never opens it and leaves the review.
  const [dropAt, setDropAt] = React.useState<number | null>(null)
  const dragDepth = React.useRef(0)
  const isFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')
  const dropProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (!isFileDrag(e) || !p.canComment) return
      if (dragDepth.current++ === 0) { p.onPause(); setDropAt(p.getPlayhead()) }
    },
    onDragLeave: (e: React.DragEvent) => { if (isFileDrag(e) && dragDepth.current > 0 && --dragDepth.current === 0) setDropAt(null) },
    onDragOver: (e: React.DragEvent) => { if (isFileDrag(e)) e.preventDefault() },
    onDrop: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault(); dragDepth.current = 0; setDropAt(null)
      if (!p.canComment) return
      addImages(Array.from(e.dataTransfer.files ?? []))
      typedRef.current?.focus()
    },
  }
  React.useEffect(() => {
    const guard = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { dragDepth.current = 0; setDropAt(null) } }
    window.addEventListener('dragover', guard); window.addEventListener('drop', guard); window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('dragover', guard); window.removeEventListener('drop', guard); window.removeEventListener('keydown', esc) }
  }, [])
  // The comment box itself turns into the drop zone; the video is never covered (Alan 2026-11-17).
  const dropOverlay = dropAt !== null && (
    <div data-testid="drop-overlay" className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl border-2 border-dashed border-accent bg-bg-secondary">
      <p className="flex items-center gap-2 text-sm font-medium text-text-primary"><Paperclip size={16} aria-hidden="true" />Drop to attach to a comment at {timecode(dropAt)}</p>
    </div>
  )
  const [messages, setMessages] = React.useState<Record<string, string>>({})
  const marks = React.useRef<InkMark[]>([])
  /** The picture under each stroke when it was drawn: the drawn frame is built from these when the note is saved. */
  const shots = React.useRef<FrameShot[]>([])
  const snap = (t: number) => {
    const canvas = snapshotVideo(rootRef.current?.querySelector('video'))
    if (canvas) shots.current = [...shots.current.slice(-11), { t, canvas }]
  }
  const framing = React.useRef(new Set<string>())
  const queueChain = React.useRef<Promise<unknown>>(Promise.resolve())
  const [replay, setReplay] = React.useState<InkReplay | null>(null)
  const replayKey = React.useRef(0)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const areaRef = React.useRef<HTMLDivElement>(null)
  const [commentsOpen, setCommentsOpen] = React.useState(false)
  const embedSide = useEmbedSide(rootRef, !!p.embed)
  const levelRef = React.useRef(0)
  const sKey = p.sessionKey ?? 'flow'
  const [toast, setToast] = React.useState<{ secs: number } | null>(null)
  const [moment, setMoment] = React.useState<{ title: string; sub?: string } | null>(null)
  const [delivery, setDelivery] = React.useState<DeliveryRef | null>(null)
  const [burst, setBurst] = React.useState(0)
  const advanceRef = React.useRef<() => void>(() => {})
  const box = React.useMemo(() => p.outbox ?? getNoteOutbox(), [p.outbox])
  const ob = useNoteOutbox(box)
  const canSave = p.canSave ?? true
  const announced = React.useRef(new Set<string>())
  React.useEffect(() => {
    for (const e of ob.entries) if (e.status === 'saved') {
      markFeedback(sKey, (e.payload as { assetId?: string })?.assetId ?? p.currentFileId)
      if (!announced.current.has(e.id)) { announced.current.add(e.id); p.onNoteSaved?.((e.payload as { t?: number })?.t ?? 0) }
    }
  }, [ob.entries]) // eslint-disable-line react-hooks/exhaustive-deps
  const busy = !!active || notes.some(n => n.status === 'recording' || n.status === 'transcribing') || ob.entries.some(e => e.status === 'queued' || e.status === 'sending')
  React.useEffect(() => { p.onBusy?.(busy) }, [busy]) // eslint-disable-line react-hooks/exhaustive-deps
  const onNeedSave = React.useRef(p.onNeedSave)
  onNeedSave.current = p.onNeedSave
  const [playing, setPlaying] = React.useState(false)
  const [time, setTime] = React.useState<number | undefined>(undefined)
  // Media events do not bubble, but they can be caught on the way down: follow whichever <video> the player mounts.
  React.useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const on = (e: Event) => { if (e.target instanceof HTMLVideoElement) { setPlaying(!e.target.paused && !e.target.ended); setTime(e.target.currentTime) } }
    const events = ['play', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'timeupdate'] as const
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

  // Optimistic save: a note goes into the outbox the moment it has its words, and the outbox does the rest in the background.
  const payloadRef = React.useRef(p.notePayload)
  payloadRef.current = p.notePayload
  React.useEffect(() => {
    for (const n of notes) {
      if (n.status !== 'ready' || !n.text.trim() || ob.byId(n.id)) continue
      if (!canSave) { onNeedSave.current?.(); continue }
      const note = { text: n.text.trim(), t: n.t, annotation: buildDrawingData(n.marks ?? []), ...(n.images?.length ? { images: n.images } : {}),
        ...(n.dictation ? { dictation: n.dictation, segmentIndex: n.segment_index ?? 0, ...(n.dictationAudio ? { dictationAudio: n.dictationAudio } : {}) } : {}) }
      if (framing.current.has(n.id)) continue
      framing.current.add(n.id)
      // Ink: render the drawn frame first (milliseconds), then queue; no frame (tainted, no video) = ink only. One chain keeps note order.
      const marksOfNote = n.marks ?? []
      queueChain.current = queueChain.current
        .then(() => (marksOfNote.length ? drawnFrameFile(nearestShot(shots.current, marksOfNote[0].t), marksOfNote) : null))
        .then(drawnFrame => ob.enqueue(n.id, payloadRef.current({ ...note, ...(drawnFrame ? { drawnFrame } : {}) })))
        .catch(() => undefined)
    }
  }, [notes, canSave, ob.entries]) // eslint-disable-line react-hooks/exhaustive-deps

  const transcribe = async (n: { id: string; t: number; marks?: InkMark[] }, audio: Blob, recordedMs?: number) => {
    const { id } = n
    dispatch({ type: 'transcribing', id, audio })
    setMessages(m => { const { [id]: _, ...rest } = m; return rest })
    try {
      const r = await dictate(audio)
      // One note per spoken sentence, each with the ink drawn while it was said (H69)
      const points = timelines.current.get(id) ?? []
      const timeAt = points.length ? (ms: number) => videoTimeAt(points, ms) : (ms: number) => Math.round((n.t + ms / 1000) * 1000) / 1000
      const parts = notesFromDictation(timeAt, r.text, r.segments ?? [], n.marks ?? [], r.words ?? [])
      // The words and the recording stay with the notes (spec 2026-11-18): one dictation id for all its sentence-notes.
      const dictation = r.text.trim() && parts.length ? dictationPayload(newDictationId(), r, parts) : undefined
      const lastWord = r.words?.length ? r.words[r.words.length - 1].end : 0
      const duration_s = Math.max((recordedMs ?? 0) / 1000, lastWord)
      dispatch({ type: 'split', id, parts: parts.map((part, i) => ({ ...part, id: i === 0 ? id : newId(), segment_index: i })), dictation,
        ...(dictation && audio.size > 0 ? { audio: { blob: audio, duration_s } } : {}) })
    }
    catch (e) { dispatch({ type: 'failed', id }); setMessages(m => ({ ...m, [id]: dictationMessage(e) })) }
  }

  /** Throws the recording away: no transcription, no note, nothing saved. */
  const cancelRecording = () => {
    const cur = activeRef.current
    if (!cur) return
    const { id, rec } = cur
    rec.cancel()
    tracker.current?.stop(); tracker.current = null
    marks.current = []
    timelines.current.delete(id)
    dispatch({ type: 'remove', id })
    setActive(null)
  }

  /** Closes the running recording and turns it into notes. `dropEmpty` (embed, Play): nothing said or drawn means no note. */
  const stopSegment = async (dropEmpty = false) => {
    const cur = activeRef.current
    if (!cur) return
    const { id, rec, t, startedAt } = cur
    setActive(null)
    const drawn = marks.current
    marks.current = []
    tracker.current?.stop()
    timelines.current.set(id, tracker.current?.points ?? [])
    tracker.current = null
    if (dropEmpty && !keepSegment(Date.now() - startedAt, drawn.length)) { rec.cancel(); timelines.current.delete(id); dispatch({ type: 'remove', id }); return }
    dispatch({ type: 'marks', id, marks: drawn })
    await transcribe({ id, t, marks: drawn }, await rec.stop(), Date.now() - startedAt)
  }

  /** Starts a recording at the playhead. Resolves false when there is no microphone (the note is dropped). */
  const startSegment = async (): Promise<boolean> => {
    const id = newId()
    const t = p.getPlayhead()
    marks.current = []
    dispatch({ type: 'add', id, t, images })
    setImages([]); setImageNote(null)
    try {
      levelRef.current = 0
      const rec = await start(v => { levelRef.current = v })
      // Embed: the video was played again while the mic was still opening; nothing was said, nothing is kept.
      if (dict.current.mic !== 'on') { rec.cancel(); dispatch({ type: 'remove', id }); return true }
      const startedAt = rec.startedAt ?? Date.now()
      tracker.current = trackVideo(rootRef.current?.querySelector('video') ?? null, startedAt)
      setActive({ id, t, rec, startedAt })
      return true
    }
    catch {
      if (p.embed) { dispatch({ type: 'remove', id }); return false }
      dispatch({ type: 'failed', id })
      setMessages(m => ({ ...m, [id]: 'Microphone unavailable. Type your note instead.' }))
      return true
    }
  }

  // Embed: the mic follows the video (lib/embed-dictation.ts). Paused = talk, playing = silence.
  const dict = React.useRef(dictInitial)
  const [micHint, setMicHint] = React.useState('')
  // Typing mode (no mic): strokes drawn while paused wait here and become a note on Play, on a typed note, or on Send. Never lost.
  const [typing, setTyping] = React.useState(false)
  const [inkPending, setInkPending] = React.useState(false)
  const flushInk = (text?: string): boolean => {
    const drawn = marks.current
    if (!p.embed || active || !drawn.length) return false
    marks.current = []; setInkPending(false)
    const id = newId()
    dispatch({ type: 'add', id, t: p.getPlayhead(), status: 'ready', images })
    dispatch({ type: 'edit', id, text: text?.trim() || 'Drawing' })
    dispatch({ type: 'marks', id, marks: drawn })
    if (images.length) { setImages([]); setImageNote(null) }
    return true
  }
  const focusTyped = React.useRef(false)
  React.useEffect(() => { if (!active && typing && focusTyped.current) { focusTyped.current = false; typedRef.current?.focus() } }, [active, typing])
  const dictate_ = (e: DictEvent) => {
    const r = dictStep(dict.current, e)
    dict.current = r.state
    setTyping(r.state.mic === 'typing')
    if (e === 'play' && r.state.mic === 'typing') {
      // Typing session ends on Play: the typed note (with any ink) is saved, then the video plays.
      const text = typed.trim()
      if (text) { if (!flushInk(text)) typeNote(); setTyped('') } else flushInk()
    }
    for (const fx of r.effects) {
      if (fx === 'start') void startSegment().then(ok => { if (!ok) dictate_('denied') })
      else if (fx === 'flush') void stopSegment(e === 'type')
      else if (fx === 'close') void stopSegment(true)
      else if (fx === 'discard') cancelRecording()
      else if (fx === 'pause') p.onPause()
      else if (fx === 'hint') { setMicHint('Microphone not available. Type your note below.') }
      // A phone keyboard would cover the video he is about to draw on: only focus where there is a real keyboard, or when typing is all that is left.
      else if (fx === 'focus' && r.state.mic === 'typing') { if (typedRef.current && !activeRef.current) typedRef.current.focus(); else focusTyped.current = true } // the field only exists in typing mode, once the recording row is gone
      else if (fx === 'focus' && (r.state.mic === 'typing' || (typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches))) typedRef.current?.focus()
    }
  }
  const prevPlaying = React.useRef(false)
  React.useEffect(() => {
    if (prevPlaying.current === playing) return
    prevPlaying.current = playing
    // Embed: the mic follows the video both ways. Elsewhere only Comment starts it, but Play still ends the segment: pause = talk, play = silence.
    if (p.embed) dictate_(playing ? 'play' : 'pause')
    else { dict.current = { ...dict.current, video: playing ? 'playing' : 'paused' }; if (playing && dict.current.mic === 'on') dictate_('play') }
  }, [playing]) // eslint-disable-line react-hooks/exhaustive-deps

  const tapComment = async () => {
    setError('')
    if (!p.embed) dict.current = { ...dict.current, video: playing ? 'playing' : 'paused' }
    dictate_('comment')
  }

  const blocked = sendBlocked(notes) || ob.summary.pending > 0 || ob.summary.failed > 0
  const hasNotes = notes.length > 0
  const unsent = p.unsentFeedback ?? 0
  const sendMode = hasNotes || unsent > 0
  const partsOpen = !!p.parts && p.parts.total > 1 && p.parts.approved < p.parts.total
  const showDone = () => setMoment({ title: doneLine(sessionSummary(sKey)) })
  const advance = () => { if (p.hasNext && p.onNext) p.onNext(); else if (!partsOpen) showDone() }
  advanceRef.current = advance

  // After Approve: "Approved" with 5 s to undo, then on to the next file (or the closing moment).
  React.useEffect(() => {
    if (!toast) return
    if (toast.secs <= 0) { setToast(null); if (delivery) setMoment({ title: 'Approved' }); else advanceRef.current(); return }
    const id = setTimeout(() => setToast({ secs: toast.secs - 1 }), 1000)
    return () => clearTimeout(id)
  }, [toast, delivery])

  // Approve one part. The server hands back the share link only once every part is approved, so a null here means "not yet".
  const approvePart = async () => {
    const made = await p.onApprove()
    markApproved(sKey, p.currentFileId)
    if (made) { setDelivery(made); setBurst(n => n + 1) }
    setToast({ secs: p.onUndoApprove ? 5 : 1 })
  }
  const finish = async () => {
    if (flushInk(typed)) { setTyped(''); return } // a drawing still waiting becomes its note first; the next tap sends
    setSending(true); setError('')
    try {
      if (!sendMode) { await approvePart(); return }
      const count = notes.length || unsent
      await p.onFinishRound?.()
      p.onSent?.()
      dispatch({ type: 'clear' })
      setMoment({ title: sentLine(count, !!p.onFinishRound), sub: p.hasNext ? undefined : doneLine(sessionSummary(sKey)) })
    } catch { setError(sendMode ? 'Could not finish. Your notes are saved. Try again.' : 'Could not approve. Try again.') }
    finally { setSending(false) }
  }
  const undo = async () => {
    setToast(null); setError('')
    try { await p.onUndoApprove?.(); unmarkApproved(sKey, p.currentFileId); setDelivery(null) }
    catch { setError('Could not undo. The file is still approved.') }
  }

  // Copying the link is what hands the work on (the request moves to Delivered); until then an Undo still means no delivery.
  const copyLink = async () => {
    if (!delivery) return
    try { await navigator.clipboard.writeText(delivery.share_url) } catch { setError(`Could not copy. Share this link: ${delivery.share_url}`); return }
    setError(''); setToast(null); setMoment({ title: 'Link copied' })
    void markHandedOn(delivery.token)
    setDelivery(null)
  }
  const finishApprove = async () => {
    setSending(true); setError('')
    try { await approvePart() } catch { setError('Could not approve. Try again.') } finally { setSending(false) }
  }
  const copyButton = delivery && (
    <button type="button" onClick={copyLink} className="flow-comment inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-full px-4 text-sm font-semibold text-text-inverse"><Link2 size={16} aria-hidden="true" />Copy share link</button>
  )

  const canApprove = p.canApprove ?? true
  const sendLabel = hasNotes ? (p.finishLabel ?? (p.onFinishRound ? 'Send to agent' : 'Done')) : !canApprove ? 'Send' : p.approved ? 'Approved' : 'Approve'

  const typeNote = (e?: React.FormEvent) => {
    e?.preventDefault()
    const text = typed.trim()
    if (!text) return
    if (flushInk(text)) { setTyped(''); return }
    const id = newId()
    dispatch({ type: 'add', id, t: p.getPlayhead(), status: 'ready', images })
    dispatch({ type: 'edit', id, text })
    setTyped('')
    setImages([]); setImageNote(null)
  }

  const doneMoment = moment && (
        <div role="dialog" aria-label="Done" className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-bg-primary/96 px-8 text-center backdrop-blur-md">
          <span className="grid h-16 w-16 place-items-center rounded-full bg-status-success/15 text-status-success"><Check size={32} aria-hidden="true" /></span>
          <p className="text-xl font-semibold leading-tight text-text-primary">{moment.title}</p>
          {moment.sub && <p className="text-sm text-text-secondary">{moment.sub}</p>}
          {delivery && <button type="button" onClick={copyLink} className="flow-comment inline-flex h-14 items-center justify-center gap-2 rounded-full px-8 text-base font-semibold text-text-inverse"><Link2 size={18} aria-hidden="true" />Copy share link</button>}
          {delivery
            ? <button type="button" onClick={() => { setMoment(null); setDelivery(null); advanceRef.current() }} className="press inline-flex min-h-11 items-center justify-center rounded-full px-4 text-sm font-semibold text-text-secondary hover:bg-bg-hover">Skip</button>
          : p.hasNext && p.onNext
            ? <button type="button" onClick={() => { setMoment(null); p.onNext!() }} className="flow-comment inline-flex h-14 items-center justify-center rounded-full px-8 text-base font-semibold text-text-inverse">Next file</button>
            : <button type="button" onClick={() => setMoment(null)} className="press inline-flex h-14 items-center justify-center rounded-full border border-border px-8 text-base font-semibold text-text-primary hover:bg-bg-hover">Close</button>}
        </div>
  )
  const filesBar = (
    <>
      {/* The briefing's files */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-bg-secondary pl-2">
        {p.lead}
        <div className="min-w-0 flex-1 py-1 pr-2">
          <ModuleTabs nav label="Files in this briefing" items={p.files} names={tabLabels(p.files.map(x => x.name))} selectedId={p.currentFileId} onSelect={id => id !== p.currentFileId && p.onSelectFile(id)} />
        </div>
        {p.onExit && !p.wide && <button type="button" onClick={p.onExit} className="press min-h-11 shrink-0 px-3 text-sm font-medium text-text-secondary hover:text-text-primary">{p.exitLabel ?? 'Exit'}</button>}
      </div>

    </>
  )
  const mediaArea = (
    <>
      {/* 9:16 at full height, letterboxed never cropped */}
      <div className="flex min-h-0 flex-1 flex-col" data-recording={active ? '' : undefined}>
        {p.renderMedia(
          <>
          {active && <div className="flow-rec-glow" data-testid="rec-glow" aria-hidden="true" />}
          <InkLayer
            active={!!active || (!!p.embed && typing && !playing)}
            playing={playing}
            time={time}
            onStart={p.onPause}
            replay={replay}
            onMark={(k, points, times) => {
              snap(p.getPlayhead())
              if (active) marks.current.push({ k, points, times, t: p.getPlayhead(), offset_ms: Date.now() - active.startedAt })
              else if (p.embed && typing) { marks.current.push({ k, points, times, t: p.getPlayhead(), offset_ms: 0 }); setInkPending(true) }
            }}
          />
          </>,
          { markers: notes.map(n => ({ t: n.t, label: stamp(n.t) })) },
        )}
      </div>

    </>
  )
  const notesList = (
    <>
      {notes.some(n => n.status !== 'recording') && (
        <ul aria-label="Your notes" className="max-h-[30dvh] shrink-0 space-y-2 overflow-y-auto border-t border-border bg-bg-secondary px-3 py-2">
          {notes.filter(n => n.status !== 'recording').map(n => {
            const entry = ob.byId(n.id)
            const replayAll = () => { p.onSeek(n.t); if (n.marks?.length) setReplay({ key: ++replayKey.current, at: n.t, marks: n.marks }) }
            return (
              <li key={n.id} data-testid="note-chip" data-state={entry?.status ?? n.status} className="flex items-start gap-2">
                <button type="button" onClick={() => p.onSeek(n.t)} aria-label={`Go to ${timecode(n.t)}`} className="press min-h-11 shrink-0 rounded-lg bg-bg-tertiary px-2.5 font-mono text-xs tabular-nums text-text-primary">{timecode(n.t)}</button>
                <div className="min-w-0 flex-1">
                  {!!n.images?.length && <div className="mb-1 flex gap-1.5" aria-label="Images in this note">{n.images.map((f, i) => <ImageThumb key={i} file={f} small />)}</div>}
                  {n.status === 'transcribing' && <p role="status" className="flex min-h-11 items-center gap-2 text-sm text-text-secondary"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" />Transcribing…</p>}
                  {(n.status === 'ready' || n.status === 'failed') && (
                    <>
                      {entry ? (
                        <p className="flex min-h-11 items-center py-1 text-base text-text-primary">
                          <span>{(n.marks?.length ? splitDeictic(n.text) : [{ text: n.text, deictic: false }]).map((part, i) => part.deictic
                            ? <button key={i} type="button" onClick={replayAll} className="press inline underline decoration-text-secondary decoration-2 underline-offset-4">{part.text}</button>
                            : <span key={i}>{part.text}</span>)}</span>
                        </p>
                      ) : (
                        <textarea aria-label={`Note at ${timecode(n.t)}`} value={n.text} rows={2} onChange={e => dispatch({ type: 'edit', id: n.id, text: e.target.value })} onBlur={() => dispatch({ type: 'commit', id: n.id })}
                          className="w-full resize-none rounded-lg border border-border bg-bg-primary px-3 py-2 text-base text-text-primary outline-none focus:border-text-tertiary" />
                      )}
                      {!!n.marks?.length && (
                        <ul aria-label={`Drawings on the note at ${timecode(n.t)}`} className="mt-1 flex flex-wrap gap-1.5">
                          {n.marks.map((m, i) => (
                            <li key={i}>
                              <button type="button" onClick={() => { p.onSeek(m.t); setReplay({ key: ++replayKey.current, at: m.t, marks: [m] }) }}
                                aria-label={`Drawing at ${stamp(m.t)}`}
                                className="press inline-flex min-h-11 items-center gap-2 rounded-full border border-border py-1 pl-1.5 pr-3 font-mono text-xs tabular-nums text-text-secondary hover:bg-bg-hover">
                                <InkThumb mark={m} />{stamp(m.t)}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {n.status === 'failed' && !entry && (
                        <p role="alert" className="flex flex-wrap items-center gap-x-3 text-xs text-text-secondary">
                          <span>{messages[n.id] ?? 'Could not transcribe.'}</span>
                          {n.audio && <button type="button" onClick={() => transcribe(n, n.audio!)} className="press inline-flex min-h-11 items-center gap-1 font-semibold text-text-primary"><RotateCcw size={12} />Try again</button>}
                        </p>
                      )}
                      {entry?.status === 'failed' && (
                        <p role="alert" className="text-xs text-status-error">{entry.error || 'Could not save.'}</p>
                      )}
                    </>
                  )}
                </div>
                <NoteStatus status={entry?.status} onRetry={() => ob.retry(n.id)} onDelete={entry ? undefined : () => dispatch({ type: 'remove', id: n.id })} label={timecode(n.t)}
                  onSendWithout={entry?.status === 'failed' && (entry.payload as NotePayload)?.images?.length ? () => { dispatch({ type: 'dropImages', id: n.id }); void ob.retryWith(n.id, { ...(entry.payload as NotePayload), images: [], dropMissingImages: true }) } : undefined} />
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
  const statusArea = (
    <>
      {error && <p role="alert" className="shrink-0 bg-bg-secondary px-4 py-2 text-sm text-status-error">{error}</p>}
      {ob.line && (
        <div className="shrink-0 border-t border-border bg-bg-secondary px-4 py-1.5 text-center" aria-live="polite">
          <p data-tone={ob.line.tone} className="text-xs font-medium tabular-nums text-text-secondary">
            {ob.line.parts.map((part, i) => <span key={i} className={part.tone === 'error' ? 'text-status-error' : part.tone === 'ok' ? 'text-status-success' : undefined}>{part.text}</span>)}
          </p>
          {ob.summary.pending > 0 && <p className="text-[11px] text-text-tertiary">Unsent notes go out next time you open this.</p>}
        </div>
      )}

      {p.parts && p.parts.total > 1 && !delivery && (
        <p role="status" data-testid="parts-progress" className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-bg-secondary pl-4 pr-1 text-xs font-medium text-text-secondary">
          <span className="tabular-nums">{p.parts.approved} of {p.parts.total} approved</span>
          {sendMode && p.canApprove !== false && !p.approved && !active && <button type="button" onClick={finishApprove} disabled={sending} className="press min-h-11 px-2 text-sm font-semibold text-text-secondary hover:text-text-primary">Approve this part</button>}
        </p>
      )}
      {toast && (
        <div role="status" className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-bg-secondary pl-4 pr-1">
          <p className="flex items-center gap-2 text-sm font-medium text-status-success"><Check size={16} aria-hidden="true" />Approved</p>
          {copyButton}
          {p.onUndoApprove && <button type="button" onClick={undo} className="press min-h-11 rounded-full px-4 text-sm font-semibold text-text-primary hover:bg-bg-hover">Undo ({toast.secs} s)</button>}
        </div>
      )}
      {active && !p.wide && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-bg-secondary pl-4 pr-1" role="status" aria-label="Recording">
          <LevelMeter levelRef={levelRef} />
          <span data-testid="rec-timer" className="min-w-[3.25rem] text-right font-mono text-[17px] font-semibold leading-[22px] tabular-nums text-text-primary">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
          <button type="button" onClick={cancelRecording} aria-label="Cancel recording" className="press grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-secondary hover:bg-bg-hover"><X size={18} /></button>
        </div>
      )}

    </>
  )
  const finishButton = (
    <button type="button" onClick={finish} disabled={sending || (hasNotes ? blocked : (p.approved || !canApprove))}
      className="press inline-flex h-14 min-w-0 shrink items-center justify-center gap-1.5 rounded-full border border-border px-4 text-sm font-semibold text-text-primary hover:bg-bg-hover disabled:opacity-50">
      {sending ? <Loader2 size={16} className="shrink-0 animate-spin motion-reduce:animate-none" /> : hasNotes ? <Send size={16} className="shrink-0" aria-hidden="true" /> : <Check size={16} className="shrink-0" aria-hidden="true" />}<span className="truncate">{sendLabel}</span>
    </button>
  )

  // Embed (Review Player v5): the video at its own ratio with the glass bar; beside it (or below, when the frame has no room) the
  // file chain, AutoReview's comment list and Comment / Approve. Same notes, ink, outbox and approve as everywhere else.
  if (p.embed) {
    const toggleVideo = (e: React.MouseEvent) => {
      if (active || (e.target as HTMLElement).closest('.ep-bar')) return
      const v = rootRef.current?.querySelector('video')
      if (!v) return
      if (v.paused) v.play().catch(() => {}); else v.pause()
    }
    const showComment = (t: number, drawing: unknown) => {
      p.onSeek(t)
      if (isInk(drawing)) setReplay({ key: ++replayKey.current, at: t, marks: drawing.marks })
      else setReplay(null)
    }
    return (
      <div ref={rootRef} className="ep-root" data-testid="flow-view" data-layout="embed" data-side={embedSide.side ? '' : undefined} tabIndex={-1}
        onKeyDown={e => embedKey(e, rootRef.current?.querySelector('video') ?? null)}>
        {doneMoment}
        <Confetti burst={burst} />
        <div ref={areaRef} className="ep-stage" style={embedSide.side ? { ['--ratio' as string]: String(embedSide.ratio) } : undefined}>
          <div className="ep-video" onClick={toggleVideo}>{mediaArea}</div>
          <EmbedBar root={rootRef} area={areaRef} playing={playing} time={time ?? p.getPlayhead()} markers={p.embedMarkers ?? notes.map(n => n.t)} />
        </div>
        <aside className="ep-side" aria-label="Review">
          {p.embedNav}
          {p.embedComments && (
            <>
              <button type="button" className="ep-comments-toggle" aria-expanded={commentsOpen} onClick={() => setCommentsOpen(o => !o)}>Comments<span className="text-text-secondary">{commentsOpen ? '⌃' : '›'}</span></button>
              <div className="ep-comments" data-open={commentsOpen || typing ? '' : undefined}>
                <div className="ep-comments-head"><span>All comments</span></div>
                <div className="ep-comments-list flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">{p.embedComments(showComment)}</div>
              </div>
            </>
          )}
          {notes.filter(n => n.status === 'failed' && !ob.byId(n.id)).map(n => (
            <p key={n.id} role="alert" className="flex flex-wrap items-center gap-x-3 rounded-lg bg-bg-secondary px-3 text-xs text-text-primary">
              <span>{messages[n.id] ?? 'Could not transcribe.'}</span>
              {n.audio && <button type="button" onClick={() => transcribe(n, n.audio!)} className="press inline-flex min-h-11 items-center gap-1 font-semibold"><RotateCcw size={12} />Try again</button>}
            </p>
          ))}
          {error && <p role="alert" className="rounded-lg bg-bg-secondary px-3 py-2 text-sm text-status-error">{error}</p>}
          {ob.summary.failed > 0 && <button type="button" onClick={() => ob.entries.filter(e => e.status === 'failed').forEach(e => ob.retry(e.id))} className="press inline-flex min-h-11 items-center gap-1 self-start rounded-full bg-bg-secondary px-3 text-xs font-semibold"><RotateCcw size={12} />Retry sending notes</button>}
          {toast && <div role="status" className="flex items-center justify-between gap-2 rounded-lg bg-bg-secondary py-1 pl-3 pr-1"><p className="flex items-center gap-2 text-sm font-medium text-status-success"><Check size={16} aria-hidden="true" />Approved</p>{copyButton}{p.onUndoApprove && <button type="button" onClick={undo} className="press min-h-11 rounded-full px-3 text-sm font-semibold text-text-primary hover:bg-bg-hover">Undo ({toast.secs} s)</button>}</div>}
          {p.parts && p.parts.total > 1 && !delivery && <p role="status" data-testid="parts-progress" className="ep-progress"><span className="tabular-nums">{p.parts.approved} of {p.parts.total} approved</span>{sendMode && p.canApprove !== false && !p.approved && !active && <button type="button" onClick={finishApprove} disabled={sending} className="press min-h-11 px-2 font-semibold text-text-secondary hover:text-text-primary">Approve this part</button>}</p>}
          {micHint && !active && <p role="status" className="ep-hint">{micHint}</p>}
          {typing && !active && notes.some(n => n.status !== 'recording') && (
            <ul className="ep-notes" aria-label="Your notes">
              {notes.filter(n => n.status !== 'recording').slice().reverse().map(n => (
                <li key={n.id}>
                  <button type="button" onClick={() => p.onSeek(n.t)} aria-label={`Go to ${stamp(n.t)}`} className="ep-note-t press">{stamp(n.t)}</button>
                  <span className="ep-note-text">{n.text || '…'}</span>
                </li>
              ))}
            </ul>
          )}
          {p.canComment && !active && typing && (
            <form onSubmit={typeNote} className="ep-type glass">
              <input ref={typedRef} value={typed} onChange={e => setTyped(e.target.value)} onFocus={p.onPause} aria-label="Type a note at the current time"
                onPaste={e => { const f = imagesFrom(e.clipboardData); if (f.length) { e.preventDefault(); addImages(f) } }}
                placeholder={`Note at ${timecode(time ?? p.getPlayhead())}`} enterKeyHint="send" />
              <button type="submit" disabled={!typed.trim()} aria-label="Add note" className="ep-send"><Send size={16} aria-hidden="true" /></button>
            </form>
          )}
          <div className="ep-actions" data-dictating={active ? '' : undefined}>
            {active && <button type="button" onClick={() => dictate_('stop')} aria-label="Cancel recording" className="ep-cancel press">Cancel</button>}
            {active && (
              <div className="ep-rec" role="status" aria-label="Recording">
                <span className="ep-rec-dot" aria-hidden="true" />
                <span data-testid="rec-timer" className="font-mono tabular-nums text-text-primary">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
              </div>
            )}
            {p.canComment && (
              <button type="button" onClick={tapComment} aria-label={active ? 'Stop recording' : 'Comment'} data-recording={active ? '' : undefined} data-secondary={sendMode && !active ? '' : undefined} className="ep-cta">
                {active ? <><Square size={16} aria-hidden="true" /><span className="ep-lbl">Stop</span></> : <><Mic size={18} aria-hidden="true" /><span className="ep-lbl">Comment</span></>}
              </button>
            )}
            {p.canComment && !active && (
              <button type="button" onClick={() => dictate_('type')} aria-label="Type a note" aria-pressed={typing} title="Type a note" className="ep-type-btn press"><Keyboard size={20} aria-hidden="true" /></button>
            )}
            {!active && (
              <button type="button" onClick={finish} disabled={sending || (sendMode ? blocked : (!!p.approved || !canApprove))} aria-label={sendMode || inkPending ? 'Send feedback' : sendLabel} data-primary={sendMode || inkPending ? '' : undefined} className="ep-approve glass">
                {sending ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" /> : sendMode || inkPending ? <Send size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}<span className="ep-lbl">{sendMode || inkPending ? 'Send feedback' : sendLabel}</span>
              </button>
            )}
          </div>
        </aside>
      </div>
    )
  }

  // Desktop (Flask): the video takes the room, notes live in a column on the right, talk / type / draw sit right under the video.
  if (p.wide) return (
    <div ref={rootRef} className="relative flex h-full min-h-0 bg-bg-primary" data-testid="flow-view" data-layout="wide" {...dropProps}>
      {doneMoment}
      <Confetti burst={burst} />
      <div className="flex min-w-0 flex-1 flex-col">
        {filesBar}
        {mediaArea}
        {p.canComment ? (
          <div className="flex shrink-0 flex-col items-center px-4 pb-4 pt-3">
            {(images.length > 0 || imageNote) && (
              <div className="mb-2 flex w-full max-w-[560px] flex-wrap items-center gap-2" aria-label="Images for this comment">
                {images.map((f, i) => <ImageThumb key={`${f.name}-${f.size}-${i}`} file={f} onRemove={() => setImages(images.filter((_, j) => j !== i))} />)}
                {imageNote && <p role="status" className="text-xs text-text-secondary">{imageNote}</p>}
              </div>
            )}
            <div className="relative flex w-full max-w-[560px] items-center gap-2 rounded-2xl border border-border bg-bg-secondary p-1.5 transition-colors focus-within:border-text-tertiary shadow-[0_8px_24px_-12px_rgba(0,0,0,.5)]">
              <button type="button" onClick={tapComment} aria-label={active ? 'Stop recording' : 'Comment'} title={active ? 'Stop (saves the note)' : 'Comment: talk and draw while it plays'}
                className="flow-comment inline-flex h-11 shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-text-inverse">
                {active ? <><Square size={16} aria-hidden="true" />Stop</> : <><Mic size={18} aria-hidden="true" />Comment</>}
              </button>
              {dropOverlay}
              {active ? (
                <div className="flex min-w-0 flex-1 items-center gap-2" role="status" aria-label="Recording">
                  <LevelMeter levelRef={levelRef} />
                  <span data-testid="rec-timer" className="min-w-[3.25rem] text-right font-mono text-sm font-semibold tabular-nums text-text-primary">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
                  <button type="button" onClick={cancelRecording} aria-label="Cancel recording" className="press grid h-11 w-11 shrink-0 place-items-center rounded-xl text-text-secondary hover:bg-bg-hover"><X size={18} /></button>
                </div>
              ) : (
                <form onSubmit={typeNote} className="flex min-w-0 flex-1 items-center gap-1">
                  <input ref={typedRef} value={typed} onChange={e => setTyped(e.target.value)} onFocus={p.onPause} aria-label="Type a note at the current time"
                    onPaste={e => { const f = imagesFrom(e.clipboardData); if (f.length) { e.preventDefault(); addImages(f) } }}
                    placeholder={`Leave feedback at ${timecode(p.getPlayhead())}…`}
                    className="h-11 min-w-0 flex-1 bg-transparent px-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none" />
                  <input ref={filePick} type="file" accept={IMAGE_TYPES.join(',')} multiple hidden onChange={e => { addImages(Array.from(e.target.files ?? [])); e.target.value = '' }} />
                  <button type="button" onClick={() => filePick.current?.click()} aria-label="Attach an image" title="Attach an image or paste a screenshot"
                    className="press grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-secondary hover:bg-bg-hover hover:text-text-primary"><Paperclip size={16} /></button>
                  <button type="submit" disabled={!typed.trim()} aria-label="Add note" className="press grid h-11 w-11 shrink-0 place-items-center rounded-full bg-bg-hover text-text-primary disabled:opacity-40"><Send size={15} /></button>
                </form>
              )}
            </div>
          </div>
        ) : <p className="shrink-0 py-3 text-center text-sm text-text-secondary">View-only access. Comments are disabled.</p>}
      </div>
      <aside aria-label="Feedback" className="flex w-[340px] shrink-0 flex-col border-l border-border bg-bg-secondary">
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
          <p className="text-sm font-semibold text-text-primary">Feedback{notes.length > 0 && <span className="ml-1.5 tabular-nums text-text-tertiary">{notes.length}</span>}</p>
          {p.onExit && <button type="button" onClick={p.onExit} className="press min-h-11 rounded-md px-3 text-xs font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary">{p.exitLabel ?? 'Exit'}</button>}
        </div>
        <div className="flex min-h-0 flex-1 flex-col [&>ul]:max-h-none [&>ul]:flex-1 [&>ul]:border-t-0">
          {notes.some(n => n.status !== 'recording') ? notesList : (
            <p className="m-auto max-w-[240px] text-center text-sm leading-relaxed text-text-tertiary">Press <span className="font-semibold text-text-secondary">Comment</span> and say what to change while it plays. Draw on the video to point. Or type below the video.</p>
          )}
        </div>
        {statusArea}
        {p.canComment && <div className="flex shrink-0 border-t border-border p-3 [&>button]:flex-1">{finishButton}</div>}
      </aside>
    </div>
  )

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-col bg-bg-primary" style={{ paddingTop: 'env(safe-area-inset-top)' }} data-testid="flow-view">
      {doneMoment}
      <Confetti burst={burst} />
      {filesBar}
      {mediaArea}
      {notesList}
      {statusArea}
      {p.canComment && (images.length > 0 || imageNote) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-bg-secondary px-3 pt-2" aria-label="Images for the next comment">
          {images.map((f, i) => <ImageThumb key={`${f.name}-${f.size}-${i}`} file={f} onRemove={() => setImages(images.filter((_, j) => j !== i))} />)}
          <p role="status" className="text-xs text-text-secondary">{imageNote ?? 'Goes with your next comment.'}</p>
        </div>
      )}
      {/* One-hand bottom controls */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border bg-bg-secondary px-3 pt-2" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
        onPaste={e => { const f = imagesFrom(e.clipboardData); if (f.length) { e.preventDefault(); addImages(f) } }}>
        {p.canComment ? (
          <>
            <input ref={filePick} type="file" accept={IMAGE_TYPES.join(',')} multiple hidden onChange={e => { addImages(Array.from(e.target.files ?? [])); e.target.value = '' }} />
            {!active && <button type="button" onClick={() => filePick.current?.click()} aria-label="Attach an image" title="Attach an image or a screenshot"
              className="press grid h-14 w-14 shrink-0 place-items-center rounded-full border border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary"><Paperclip size={20} /></button>}
            <button type="button" onClick={tapComment}
              className="flow-comment inline-flex h-14 min-w-[7.5rem] flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-full px-4 text-base font-semibold text-text-inverse">
              {active ? <><Square size={18} aria-hidden="true" />Stop</> : <><Mic size={20} aria-hidden="true" />Comment</>}
            </button>
            {finishButton}
          </>
        ) : <p className="flex-1 py-3 text-center text-sm text-text-secondary">View-only access. Comments are disabled.</p>}
      </div>
    </div>
  )
}
