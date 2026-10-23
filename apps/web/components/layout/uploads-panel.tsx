'use client'

import * as React from 'react'
import {
  X,
  CheckCircle,
  AlertCircle,
  Loader2,
  Film,
  Music,
  Image as ImageIcon,
  FileIcon,
  RotateCcw,
  Ban,
  Cog,
  PauseCircle,
  Trash2,
  MonitorUp,
  Pencil,
} from 'lucide-react'
import { cn, formatBytes, formatRelativeTime, formatTimeLeft } from '@/lib/utils'
import { useShallow } from 'zustand/react/shallow'
import { useUploadStore, visibleFiles, findRow, isOnItsWay, type UploadFile } from '@/stores/upload-store'
import { useUploadSpeedStore } from '@/stores/upload-speed-store'
import { carriesFiles } from '@/lib/drag'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getFileIcon(fileType: string) {
  if (fileType.startsWith('video/')) return <Film className="h-5 w-5" />
  if (fileType.startsWith('audio/')) return <Music className="h-5 w-5" />
  if (fileType.startsWith('image/')) return <ImageIcon className="h-5 w-5" />
  return <FileIcon className="h-5 w-5" />
}

type FilterTab = 'all' | 'active' | 'complete' | 'failed'

/** A resume the user asked for, waiting for its turn: `interrupted` in storage, on its way in the panel. */
const isWaitingResume = (f: UploadFile) => f.status === 'interrupted' && f.queuedResume === true

function matchesFilter(f: UploadFile, filter: FilterTab): boolean {
  switch (filter) {
    case 'all': return true
    // `interrupted` is deliberately not active: nothing is being transferred, so
    // listing it here would put a row that cannot move next to ones that are.
    // `elsewhere` is: bytes are moving, just not from this tab. So are rows
    // waiting in the queue, a resume among them: they are on their way.
    case 'active': return isOnItsWay(f) || f.status === 'elsewhere'
    case 'complete': return f.status === 'complete'
    case 'failed':
      return f.status === 'failed' || f.status === 'cancelled' ||
        (f.status === 'interrupted' && !isWaitingResume(f))
  }
}

/**
 * The order rows are listed in: the way they will start.
 *
 * Drops newest first, and within a drop the first to start at the top. A Resume
 * or a Retry is a drop of its own, so it lists first. Rows with no place in the
 * queue (history, and anything saved by an earlier page load, whose numbers
 * mean nothing against this one's) follow, newest first.
 */
function byQueueOrder(a: UploadFile, b: UploadFile): number {
  const aQueued = a.dropSeq !== undefined
  const bQueued = b.dropSeq !== undefined
  if (aQueued !== bQueued) return aQueued ? -1 : 1
  if (aQueued && bQueued) {
    if (a.dropSeq !== b.dropSeq) return b.dropSeq! - a.dropSeq!
    return (a.queueSeq ?? 0) - (b.queueSeq ?? 0)
  }
  return b.createdAt - a.createdAt
}

/**
 * The heading of a day before yesterday, "Oct 18". One formatter, made on first
 * use and kept: the listing is worked out on every write to the store, and
 * `toLocaleDateString` builds a new formatter on every call. It formats with the
 * same locale and options, so the labels are the same to the byte.
 */
let dayFormat: Intl.DateTimeFormat | null = null
function dayLabel(): Intl.DateTimeFormat {
  if (dayFormat === null) dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
  return dayFormat
}

/**
 * Groups an already sorted list under date headings, keeping its order.
 *
 * A row with a `dropSeq` was dropped, picked, resumed or retried in this page
 * load, so it belongs under Today whatever its `createdAt` says: a Resume of a
 * three-day-old row is a new drop, and it lists first. Bucketing it by the
 * row's own date would put "Oct 18" above the newest drop. The rows without a
 * `dropSeq` follow in `createdAt` order, so their days are already in order.
 */
function groupByDate(files: UploadFile[]): { label: string; items: UploadFile[] }[] {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = today - 86400000

  const groups: Record<string, UploadFile[]> = {}

  for (const f of files) {
    let label: string
    if (f.dropSeq !== undefined || f.createdAt >= today) {
      label = 'Today'
    } else if (f.createdAt >= yesterday) {
      label = 'Yesterday'
    } else {
      label = dayLabel().format(f.createdAt)
    }
    if (!groups[label]) groups[label] = []
    groups[label].push(f)
  }

  return Object.entries(groups).map(([label, items]) => ({ label, items }))
}

/**
 * What the panel lists for `filter`, top to bottom, as plain strings: `h:` and
 * a date heading, or `r:` and a row id. Strings, flat, so that `useShallow`
 * can tell an unchanged listing from a changed one: a progress write leaves
 * every entry as it was, so the panel does not re-render for it, and the row
 * it changed re-renders on its own.
 */
function listingOf(files: UploadFile[], filter: FilterTab): string[] {
  // The way rows will start, not the time they were added: see `byQueueOrder`.
  const listed = files.filter((f) => matchesFilter(f, filter)).sort(byQueueOrder)
  const entries: string[] = []
  for (const group of groupByDate(listed)) {
    entries.push(`h:${group.label}`)
    for (const f of group.items) entries.push(`r:${f.id}`)
  }
  return entries
}

interface PanelCounts {
  all: number
  active: number
  complete: number
  failed: number
  /** Rows still waiting for their turn: a new file, the hold's probe, or a resume. */
  queued: number
}

function countsOf(files: UploadFile[]): PanelCounts {
  const counts: PanelCounts = { all: files.length, active: 0, complete: 0, failed: 0, queued: 0 }
  for (const f of files) {
    if (matchesFilter(f, 'active')) counts.active++
    if (f.status === 'complete') counts.complete++
    if (matchesFilter(f, 'failed')) counts.failed++
    if (f.status === 'queued' || isWaitingResume(f)) counts.queued++
  }
  return counts
}

/**
 * The header's count: the files running ("3 active") apart from the ones
 * waiting for their turn ("2 queued"), as the rows' own badges show them. The
 * Active tab counts both, since both are on their way.
 */
function headerCount(counts: PanelCounts): string {
  const running = counts.active - counts.queued
  const parts: string[] = []
  if (running > 0) parts.push(`${running} active`)
  if (counts.queued > 0) parts.push(`${counts.queued} queued`)
  return parts.join(' · ')
}

/** A listing back in its date groups, in order. */
function groupsOf(listing: string[]): { label: string; ids: string[] }[] {
  const groups: { label: string; ids: string[] }[] = []
  for (const entry of listing) {
    if (entry.startsWith('h:')) groups.push({ label: entry.slice(2), ids: [] })
    else groups[groups.length - 1].ids.push(entry.slice(2))
  }
  return groups
}

/** What a closed panel selects: nothing to sort or count on every write. */
const NO_LISTING: string[] = []
const NO_COUNTS: PanelCounts = { all: 0, active: 0, complete: 0, failed: 0, queued: 0 }

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ upload }: { upload: UploadFile }) {
  const { status, finalizing } = upload
  // A resume waiting for its turn reads like any other file waiting for one.
  if (isWaitingResume(upload)) {
    return <span className="inline-flex items-center rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-medium text-text-tertiary">Queued</span>
  }
  switch (status) {
    case 'queued':
      return <span className="inline-flex items-center rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-medium text-text-tertiary">Queued</span>
    case 'starting':
      return <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent"><Loader2 className="h-2.5 w-2.5 animate-spin" />{upload.resuming ? 'Resuming' : 'Starting'}</span>
    case 'uploading':
      return <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent"><Loader2 className="h-2.5 w-2.5 animate-spin" />{finalizing ? 'Finalizing' : 'Uploading'}</span>
    case 'processing':
      return <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400"><Cog className="h-2.5 w-2.5 animate-spin" />Processing</span>
    case 'complete':
      return <span className="inline-flex items-center gap-1 rounded-full bg-status-success/10 px-2 py-0.5 text-[10px] font-medium text-status-success"><CheckCircle className="h-2.5 w-2.5" />Ready</span>
    case 'failed':
      return <span className="inline-flex items-center gap-1 rounded-full bg-status-error/10 px-2 py-0.5 text-[10px] font-medium text-status-error"><AlertCircle className="h-2.5 w-2.5" />Failed</span>
    case 'cancelled':
      return <span className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-medium text-text-tertiary"><Ban className="h-2.5 w-2.5" />Cancelled</span>
    case 'interrupted':
      return <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400"><PauseCircle className="h-2.5 w-2.5" />Interrupted</span>
    case 'elsewhere':
      return <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent"><MonitorUp className="h-2.5 w-2.5" />Elsewhere</span>
  }
}

// ─── What a row says it is doing ──────────────────────────────────────────────

/** The kind of line under a row, as a stable name for tests and the e2e suite. */
type DetailKind =
  | 'waiting-to-start' | 'waiting-for-connection' | 'waiting-for-storage' | 'waiting-to-resume'
  | 'starting' | 'resuming'
  | 'uploading' | 'finalizing' | 'processing' | 'complete' | 'failed' | 'elsewhere' | 'interrupted'

/**
 * The line a row that has not begun, or has only just, shows (spec, "Row
 * lifecycle", "Panel shows"). Null for every other row: their lines are drawn
 * from their own progress and errors.
 *
 * A row that is the hold's probe says why the queue is waiting; the rest
 * simply wait their turn.
 */
function waitingLine(upload: UploadFile): { kind: DetailKind; text: string } | null {
  if (upload.status === 'queued' || isWaitingResume(upload)) {
    if (upload.holdReason === 'connection') return { kind: 'waiting-for-connection', text: 'Waiting for connection' }
    if (upload.holdReason === 'storage') return { kind: 'waiting-for-storage', text: 'Waiting for storage' }
    return upload.status === 'queued'
      ? { kind: 'waiting-to-start', text: 'Waiting to start' }
      : { kind: 'waiting-to-resume', text: 'Waiting to resume' }
  }
  if (upload.status === 'starting') {
    return upload.resuming
      ? { kind: 'resuming', text: 'Resuming…' }
      : { kind: 'starting', text: 'Starting…' }
  }
  return null
}

/** The `data-detail` of a row: the kind of line it shows, or undefined for none. */
function detailKind(upload: UploadFile): DetailKind | undefined {
  const waiting = waitingLine(upload)
  if (waiting) return waiting.kind
  switch (upload.status) {
    case 'uploading': return upload.finalizing ? 'finalizing' : 'uploading'
    case 'processing': return 'processing'
    case 'complete': return 'complete'
    case 'failed': return upload.error ? 'failed' : undefined
    case 'elsewhere': return 'elsewhere'
    case 'interrupted': return 'interrupted'
    default: return undefined
  }
}

// ─── Asset name ───────────────────────────────────────────────────────────────

/**
 * The asset name, editable in place.
 *
 * The name is decided in the dialog before a byte moves, which is the one
 * moment the file is not yet on screen next to it -- and a file dropped
 * straight onto a folder skips that dialog entirely, so the name is whatever
 * the camera or the NLE called the file. This is where it can be corrected:
 * `asset_id` is known as soon as `/upload/initiate` answers, long before the
 * transfer ends, and `/upload/complete` does not write the name again, so a
 * rename at 40% survives the upload it is riding on.
 */
function UploadName({
  upload,
  onError,
}: {
  upload: UploadFile
  /** Reported upwards rather than shown here: the name sits in a flex row
   *  beside the status badge, and the row already has a line for errors. */
  onError: (message: string | null) => void
}) {
  const renameUpload = useUploadStore((s) => s.renameUpload)
  // Offered before the asset exists too: the row is what `/upload/initiate`
  // reads for the name, so an edit made while it still says "Queued" is
  // carried into the asset it creates rather than being dropped.
  const canRename = !upload.fromHistory

  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(upload.assetName)
  // Guards the cancel path only. Whether removing a focused element raises a
  // blur on the way out is browser-dependent, and one arriving after Escape
  // would save the draft Escape just refused. The save path needs no guard:
  // the store's own "nothing changed" check makes a second commit of the same
  // draft a no-op, because the first one already wrote it.
  const settled = React.useRef(false)

  const open = () => {
    setDraft(upload.assetName)
    onError(null)
    settled.current = false
    setEditing(true)
  }

  const commit = async () => {
    if (settled.current) return
    settled.current = true
    setEditing(false)
    onError(await renameUpload(upload.id, draft))
  }

  const cancel = () => {
    settled.current = true
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        className="flex-1 min-w-0 bg-transparent border-b border-accent outline-none text-sm font-medium text-text-primary px-0.5"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit()
          if (e.key === 'Escape') cancel()
        }}
        aria-label="Asset name"
        autoFocus
      />
    )
  }

  if (!canRename) {
    return (
      <p className="text-sm font-medium text-text-primary truncate flex-1">
        {upload.assetName}
      </p>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        title="Rename"
        className="text-sm font-medium text-text-primary truncate flex-1 text-left hover:underline decoration-dotted underline-offset-2"
      >
        {upload.assetName}
      </button>
      {/* The name is clickable on its own, but nothing about a line of text
          says so. The pencil is the part that can be seen. */}
      <button
        type="button"
        onClick={open}
        title="Rename"
        aria-label={`Rename ${upload.assetName}`}
        className="shrink-0 h-5 w-5 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </>
  )
}

// ─── Relative time ────────────────────────────────────────────────────────────

/**
 * One clock for every "N minutes ago" in the panel, ticking once a minute while
 * anything shows one. The interval starts with the first reader and stops with
 * the last, so a closed panel, or one with no completed row, runs no timer.
 */
const TICK_MS = 60_000
let tick = 0
let tickTimer: ReturnType<typeof setInterval> | null = null
const tickListeners = new Set<() => void>()

function subscribeTick(listener: () => void): () => void {
  tickListeners.add(listener)
  if (tickTimer === null) {
    tickTimer = setInterval(() => {
      tick++
      tickListeners.forEach((l) => l())
    }, TICK_MS)
  }
  return () => {
    tickListeners.delete(listener)
    if (tickListeners.size === 0 && tickTimer !== null) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  }
}

const readTick = () => tick

/**
 * "3 minutes ago", kept current. Rows re-render only on their own data, so a
 * completed row would otherwise say "just now" for as long as the panel stayed
 * open. The tick re-renders this text and nothing around it.
 */
function RelativeTime({ at }: { at: number }) {
  React.useSyncExternalStore(subscribeTick, readTick, readTick)
  return <>{formatRelativeTime(new Date(at).toISOString())}</>
}

// ─── Upload Item ──────────────────────────────────────────────────────────────

const DISMISS_KEPT = 'Dismiss (the partial upload stays on the server until it is cleaned up)'

/**
 * One row of the panel, by id.
 *
 * It reads its own row and nothing else, and is memoised on the id, so a
 * progress write, which replaces only the row it changes, re-renders only that
 * row (spec goal 14). A row that has just left the store, or is another
 * account's, reads as undefined and draws nothing.
 */
export const UploadItem = React.memo(function UploadItem({ fileId }: { fileId: string }) {
  // Only the signed-in account's row, as `visibleFiles` has it: whose row this
  // is does not rest on the listing alone.
  const upload = useUploadStore((s) => {
    const r = findRow(s, fileId)
    return r !== undefined && r.ownerId !== undefined && r.ownerId === s.subject ? r : undefined
  })
  if (!upload) return null
  return <UploadRow upload={upload} />
})

function UploadRow({ upload }: { upload: UploadFile }) {
  // One selector per action: actions never change, and reading the whole store
  // here would re-render the row on every write to any other.
  const cancelUpload = useUploadStore((s) => s.cancelUpload)
  const removeFile = useUploadStore((s) => s.removeFile)
  const resumeUpload = useUploadStore((s) => s.resumeUpload)
  const discardUpload = useUploadStore((s) => s.discardUpload)
  const retryUpload = useUploadStore((s) => s.retryUpload)
  // Asked of the store rather than guessed from the row: both depend on what
  // this tab holds in memory (the `File` behind a refused row; a run still
  // settling, a Discard still out), which a row read from storage cannot say.
  const canRetry = useUploadStore((s) => s.canRetry(upload.id))
  const canResume = useUploadStore((s) => s.canResume(upload.id))
  const [renameError, setRenameError] = React.useState<string | null>(null)
  const waitingResume = isWaitingResume(upload)
  // Cancel is offered from the moment the row is added: before its turn it
  // only gives up its place. A resume's Cancel puts it back to `interrupted`,
  // whether it waits for its turn or has just begun it, and aborts nothing.
  const isUploading = upload.status === 'queued' || upload.status === 'starting' || upload.status === 'uploading' ||
    waitingResume
  const isProcessing = upload.status === 'processing'
  // A stopped transfer nobody has asked to carry on. One waiting for its turn
  // is `interrupted` in the store but is on its way: it offers Cancel instead.
  const isInterrupted = upload.status === 'interrupted' && !waitingResume
  const waiting = waitingLine(upload)
  // Every byte is across and storage is assembling the parts. Nothing is left
  // for a cancel to stop, and one now would race the completion.
  const isFinalizing = upload.status === 'uploading' && !!upload.finalizing
  // Only the tab doing the transfer measures it, so a row from another tab or
  // from before a reload has no rate and shows none.
  const rate = useUploadSpeedStore((s) => s.rates[upload.id])
  // A file that has not started has no progress to show.
  const showProgress = upload.status === 'uploading' || isProcessing

  // Discard is the one control here whose effect cannot be taken back: the
  // parts are deleted the moment it returns, and there is no version restore.
  const [confirmingDiscard, setConfirmingDiscard] = React.useState(false)
  const [discardError, setDiscardError] = React.useState<string | null>(null)

  const progressValue = isProcessing ? upload.processingProgress : upload.progress

  // The browser will not reopen a local file on its own, so resuming needs the
  // user to hand it back. Re-selection is inherent to every browser-based
  // resumable uploader, not something this design chose.
  const filePicker = React.useRef<HTMLInputElement>(null)
  const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0]
    // Cleared so picking the same file twice in a row still fires a change.
    e.target.value = ''
    if (picked) resumeUpload(upload.id, picked)
  }

  return (
    <div
      className="group flex items-start gap-3 px-4 py-3 hover:bg-bg-hover/50 transition-colors"
      // Stable hooks for tests, and for the e2e suite, which must not select on
      // classes: what the row is, and which kind of line it shows.
      data-testid="upload-row"
      data-status={upload.status}
      data-detail={detailKind(upload)}
    >
      {/* Icon */}
      <div className="h-10 w-10 shrink-0 rounded-md bg-bg-tertiary flex items-center justify-center text-text-tertiary overflow-hidden">
        {getFileIcon(upload.fileType)}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <UploadName upload={upload} onError={setRenameError} />
          <StatusBadge upload={upload} />
        </div>
        <p className="text-xs text-text-tertiary truncate mt-0.5">
          {/* The file, whenever it is not simply the asset's name. Uploading a
              new version names the row after the asset, so the row read
              "Fujitsu 1.1" while a completely different file was going up --
              and the panel is the one place that should say which file. */}
          {upload.fileName && upload.fileName !== upload.assetName && (
            <>{upload.fileName} &middot; </>
          )}
          {upload.projectName || upload.projectId.slice(0, 8)} &middot; {formatBytes(upload.fileSize)}
        </p>

        {/* Progress bar */}
        {showProgress && (
          <div
            role="progressbar"
            aria-label={isProcessing ? 'Processing progress' : 'Upload progress'}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressValue}
            className="mt-2 h-1.5 w-full rounded-full bg-bg-tertiary overflow-hidden"
          >
            <div
              className={cn(
                'h-full rounded-full transition-all duration-300',
                isProcessing ? 'bg-amber-400' : 'bg-accent',
              )}
              style={{ width: `${progressValue}%` }}
            />
          </div>
        )}

        {/* Detail line */}
        <div className="flex items-center gap-1 mt-1">
          {waiting && (
            <span className="text-[11px] text-text-secondary truncate">{waiting.text}</span>
          )}
          {upload.status === 'uploading' && (
            <span className="text-[11px] text-text-secondary">
              {isFinalizing ? 'Finalizing...' : `Uploading ${upload.progress}%`}
            </span>
          )}
          {upload.status === 'uploading' && !isFinalizing && rate && (
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-text-tertiary">
              {formatBytes(rate.bytesPerSecond)}/s
              {rate.secondsLeft !== null && <> &middot; {formatTimeLeft(rate.secondsLeft)}</>}
            </span>
          )}
          {upload.status === 'processing' && (
            <span className="text-[11px] text-amber-400">
              {upload.processingProgress > 0 ? `Processing ${upload.processingProgress}%` : 'Processing...'}
            </span>
          )}
          {upload.status === 'complete' && (
            <span className="text-[11px] text-text-tertiary">
              <RelativeTime at={upload.createdAt} />
            </span>
          )}
          {upload.status === 'failed' && upload.error && (
            <span className="text-[11px] text-status-error truncate">{upload.error}</span>
          )}
          {upload.status === 'elsewhere' && (
            // Offers nothing. Discard from here would delete the parts under a
            // transfer that is still running, and a resume would send the same
            // parts twice into one upload.
            <span className="text-[11px] text-text-secondary truncate">
              Still uploading in another tab or on another device
            </span>
          )}
          {isInterrupted && (
            // The reason gets the whole line, and red when there is one. A
            // rejected file is the case that matters: it is the only outcome the
            // user caused and can correct, and it read as a shrug when it shared
            // the muted colour of "the network dropped" and had a hint appended
            // after it that pushed it out of the truncation.
            <span
              className={cn(
                'text-[11px] truncate',
                upload.error ? 'text-status-error' : 'text-amber-400/90',
              )}
            >
              {upload.error ?? 'Transfer stopped \u00b7 resume to send only what is missing'}
            </span>
          )}
          {/* The name has already snapped back by the time this shows, which
              says something went wrong but not what. `upload.renameError` is
              the same thing for a correction the store sent on its own, during
              the initiate round trip, where there was no click to report back
              to. The local one wins: it belongs to the edit just made. */}
          {(renameError ?? upload.renameError) && (
            <span className="text-[11px] text-status-error truncate">
              {renameError ?? upload.renameError}
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {isInterrupted && (
          <>
            {/* Resume only while the store would take it up: not while a run
                of the row is still settling or a Discard of it is out. */}
            {canResume && (
              <>
                <input
                  ref={filePicker}
                  type="file"
                  accept={upload.fileType || undefined}
                  className="hidden"
                  onChange={onPicked}
                />
                <button
                  onClick={() => filePicker.current?.click()}
                  className="h-6 w-6 flex items-center justify-center rounded text-text-tertiary hover:text-accent hover:bg-bg-hover transition-colors"
                  title={`Resume — pick ${upload.fileName} again`}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            <button
              onClick={() => { setDiscardError(null); setConfirmingDiscard(true) }}
              className="h-6 w-6 flex items-center justify-center rounded text-text-tertiary hover:text-status-error hover:bg-bg-hover transition-colors"
              title="Discard this upload and free the space it is holding"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
            {/* A Discard that could not finish keeps the row. If it goes on
                failing, nothing else would ever remove it. */}
            {upload.discardFailed && (
              <button
                onClick={() => removeFile(upload.id)}
                className="h-6 w-6 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
                // Unlike a failed row's Dismiss this leaves something behind,
                // and the user is the one choosing to.
                title={DISMISS_KEPT}
                aria-label={DISMISS_KEPT}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </>
        )}
        <ConfirmDialog
          open={confirmingDiscard}
          onOpenChange={setConfirmingDiscard}
          title={`Discard ${upload.fileName}?`}
          description="The parts already sent are deleted now and cannot be recovered. To finish this upload instead, resume it."
          confirmLabel="Discard"
          variant="danger"
          error={discardError}
          onConfirm={async () => {
            const refused = await discardUpload(upload.id)
            // The dialog stays open on a message, which is how it says why.
            if (refused) {
              setDiscardError(refused)
              throw new Error(refused)
            }
          }}
        />
        {isUploading && !isFinalizing && (
          <button
            onClick={() => cancelUpload(upload.id)}
            className="h-6 w-6 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Cancel upload"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        {(upload.status === 'complete' || upload.status === 'cancelled') && (
          <button
            onClick={() => removeFile(upload.id)}
            className="h-6 w-6 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Remove"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        {upload.status === 'failed' && (
          <>
            {/* Only while this tab still holds the `File`: not after a reload,
                and not for a file it can no longer read. */}
            {canRetry && (
              <button
                onClick={() => retryUpload(upload.id)}
                className="h-6 w-6 flex items-center justify-center rounded text-text-tertiary hover:text-accent hover:bg-bg-hover transition-colors"
                title="Retry"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            )}
            {/* Every failed row can be dismissed, whatever the reason. */}
            <button
              onClick={() => removeFile(upload.id)}
              className="h-6 w-6 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export function UploadsPanel({
  railCollapsed = true,
}: {
  /** Whether the sidebar is the 52px rail or expanded to 220px. The panel
   *  opens against its right edge, so it has to know which. */
  railCollapsed?: boolean
} = {}) {
  const panelOpen = useUploadStore((s) => s.panelOpen)
  const setPanelOpen = useUploadStore((s) => s.setPanelOpen)
  const clearCompleted = useUploadStore((s) => s.clearCompleted)
  const cancelAllQueued = useUploadStore((s) => s.cancelAllQueued)
  const fetchHistory = useUploadStore((s) => s.fetchHistory)
  const fetchMoreHistory = useUploadStore((s) => s.fetchMoreHistory)
  const historyHasMore = useUploadStore((s) => s.historyHasMore)
  const historyLoading = useUploadStore((s) => s.historyLoading)
  const [filter, setFilter] = React.useState<FilterTab>('active')
  // The signed-in account's rows only: another account's stay in the store,
  // hidden, and are neither listed nor counted. Ids and numbers rather than
  // rows, so that the panel re-renders when what it lists changes and not on
  // every progress write (spec goal 14).
  const listing = useUploadStore(useShallow((s) => (s.panelOpen ? listingOf(visibleFiles(s), filter) : NO_LISTING)))
  const counts = useUploadStore(useShallow((s) => (s.panelOpen ? countsOf(visibleFiles(s)) : NO_COUNTS)))
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const sentinelRef = React.useRef<HTMLDivElement>(null)

  // Fetch backend history when panel opens
  React.useEffect(() => {
    if (panelOpen) {
      fetchHistory()
    }
  }, [panelOpen, fetchHistory])

  // Infinite scroll — IntersectionObserver on sentinel (skip on Active tab
  // since its items come from the live upload store, not paginated history)
  React.useEffect(() => {
    if (!panelOpen || filter === 'active') return
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && historyHasMore && !historyLoading) {
          fetchMoreHistory()
        }
      },
      { root: scrollRef.current, rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [panelOpen, filter, historyHasMore, historyLoading, fetchMoreHistory])

  if (!panelOpen) return null

  // `cancelAllQueued` applies each waiting row's own Cancel and never touches a
  // row whose turn has begun, so the action is offered exactly while it has
  // someone to act on.
  const anyQueued = counts.queued > 0

  const tabs: { id: FilterTab; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: counts.all },
    { id: 'active', label: 'Active', count: counts.active },
    { id: 'complete', label: 'Complete', count: counts.complete },
    { id: 'failed', label: 'Failed', count: counts.failed },
  ]

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        onClick={() => setPanelOpen(false)}
        // A file dragged onto the page is aimed at what is behind this, not at
        // it. The backdrop exists to catch a click outside the panel, but it
        // covers the viewport, so leaving it in the way makes every drop target
        // on the page dead for as long as the panel is open. Stepping aside is
        // the honest reading of the gesture -- the drag then continues onto the
        // asset area underneath.
        onDragEnter={(e) => {
          if (carriesFiles(e)) setPanelOpen(false)
        }}
      />

      {/* Panel */}
      <div
        // Anchored to the sidebar's right edge, which moves. A fixed 52px was
        // the collapsed rail's width, so with the sidebar expanded the panel
        // opened on top of it and cut every label back to its first letter --
        // the very labels expanding the sidebar is for. Both widths are spelled
        // out because Tailwind only generates classes it can find whole.
        //
        // The offset is gated at `md` because the panel is a hard 380px: on a
        // phone, 220 + 380 is wider than the screen, and nothing can scroll to
        // what falls off, so the close button and the tab bar would simply be
        // unreachable. The rail only expands by hand and does not persist, so
        // below `md` the panel stays where a collapsed rail puts it.
        className={cn(
          'fixed left-safe top-0 z-50 h-dvh w-[380px]',
          '[--ff-left:52px]',
          !railCollapsed && 'md:[--ff-left:220px]',
          'border-r border-border bg-bg-secondary shadow-2xl flex flex-col pb-safe animate-in slide-in-from-left-4 duration-150',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-12 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-text-primary">
            Uploads
            {counts.active > 0 && (
              <span className="ml-1.5 text-xs font-normal text-accent">
                {headerCount(counts)}
              </span>
            )}
          </h2>
          <div className="flex items-center gap-1">
            {anyQueued && (
              <button
                onClick={cancelAllQueued}
                className="text-xs text-text-tertiary hover:text-text-secondary transition-colors px-2 py-1 rounded hover:bg-bg-hover"
              >
                Cancel all queued
              </button>
            )}
            {counts.complete > 0 && (
              <button
                onClick={clearCompleted}
                className="text-xs text-text-tertiary hover:text-text-secondary transition-colors px-2 py-1 rounded hover:bg-bg-hover"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => setPanelOpen(false)}
              className="h-7 w-7 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="px-3 pt-2.5 pb-1 shrink-0">
          <div className="flex items-center bg-white/5 rounded-lg p-0.5">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setFilter(tab.id)}
                className={cn(
                  'flex-1 py-1.5 text-[11px] font-medium rounded-md transition-all',
                  filter === tab.id
                    ? 'bg-white/10 text-text-primary shadow-sm'
                    : 'text-text-tertiary hover:text-text-secondary',
                )}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className={cn(
                    'ml-1 text-[10px]',
                    filter === tab.id ? 'text-text-secondary' : 'text-text-quaternary',
                  )}>
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {listing.length === 0 && !historyLoading ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <div className="h-12 w-12 rounded-full bg-bg-tertiary flex items-center justify-center mb-3">
                <FileIcon className="h-6 w-6 text-text-tertiary" />
              </div>
              <p className="text-sm text-text-secondary">
                {filter === 'all' ? 'No uploads yet' : `No ${filter} uploads`}
              </p>
              <p className="text-xs text-text-tertiary mt-1">
                {filter === 'all'
                  ? 'Upload files from any project to track them here.'
                  : 'Items will appear here as uploads progress.'}
              </p>
            </div>
          ) : (
            <>
              {groupsOf(listing).map((group) => (
                <div key={group.label}>
                  <div className="px-4 pt-4 pb-1">
                    <span
                      data-testid="upload-group"
                      className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider"
                    >
                      {group.label}
                    </span>
                  </div>
                  {group.ids.map((id) => (
                    <UploadItem key={id} fileId={id} />
                  ))}
                </div>
              ))}

              {/* Sentinel for infinite scroll + loading indicator (skip on Active tab) */}
              {filter !== 'active' && <div ref={sentinelRef} className="h-1" />}
              {historyLoading && (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}
