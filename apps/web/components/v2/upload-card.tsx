'use client'

import * as React from 'react'
import { Check, RotateCcw, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/platform'
import { FolderArt } from './folder-art'
import { ReviewWaiting } from './review-waiting'

export type UploadPhase = 'queued' | 'uploading' | 'uploaded' | 'submitted' | 'reviewing' | 'done' | 'error'

const PHASE_TEXT: Record<UploadPhase, string> = {
  queued: 'Waiting to upload',
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  submitted: 'Submitted',
  reviewing: 'Reviewing',
  done: 'Reviewed',
  error: 'Stopped',
}

/** The file itself as the icon: its first frame (video) or the image. Real beats a symbol. */
function Thumb({ file, done }: { file?: File; done: boolean }) {
  const [url, setUrl] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!file) return
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])
  if (!file || !url) return <FolderArt size={64} label={done ? 'DONE' : 'FILE'} />
  return (
    <span className="relative block h-16 w-16 shrink-0 overflow-hidden rounded-[var(--radius-md)] bg-black ring-1 ring-[var(--glass-border)]">
      {file.type.startsWith('image/')
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={url} alt="" className="h-full w-full object-cover" />
        : <video src={`${url}#t=0.5`} muted playsInline preload="metadata" className="h-full w-full object-cover" />}
      {done && <span className="absolute inset-0 grid place-items-center bg-black/45 fade-in"><Check className="h-6 w-6 text-status-success" /></span>}
    </span>
  )
}

export function UploadCard({ name, size, progress, phase, error, onRetry, onRemove, className, file }: {
  file?: File
  name: string
  size: number
  progress: number
  phase: UploadPhase
  error?: string
  onRetry?: () => void
  onRemove?: () => void
  className?: string
}) {
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100)
  const finished = phase === 'done' || phase === 'uploaded' || phase === 'submitted'
  return (
    <div className={cn('glass p-5 sm:p-6', className)} role="status" aria-live="polite">
      <div className="flex items-center gap-4">
        <Thumb file={file} done={finished} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[17px] font-semibold tracking-tight text-text-primary">{name}</p>
          <p className="mt-0.5 text-[13px] text-text-secondary">{formatBytes(size)}</p>
        </div>
        {onRemove && phase !== 'uploading' && (
          <button type="button" onClick={onRemove} aria-label="Remove" className="press grid h-11 w-11 place-items-center rounded-full text-text-tertiary hover:bg-bg-hover hover:text-text-primary">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {phase === 'reviewing' ? <ReviewWaiting /> : <div className="mt-5 rounded-[var(--radius-lg)] border border-border bg-bg-primary/40 px-4 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-[15px] text-text-primary">
            {finished ? <Check className="h-4 w-4 text-status-success" /> :
             phase === 'error' ? <span className="h-2 w-2 rounded-full bg-status-error" /> :
             phase === 'queued' ? <span className="h-2 w-2 rounded-full bg-text-tertiary" /> :
             <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-text-tertiary border-t-accent" />}
            {PHASE_TEXT[phase]}{phase === 'uploading' ? '…' : ''}
          </span>
          {phase === 'uploading' && (
            <span className="text-[28px] font-light leading-none tabular-nums tracking-tight text-text-primary">{Math.round(pct)}%</span>
          )}
          {phase === 'error' && onRetry && (
            <button type="button" onClick={onRetry} className="press inline-flex h-9 items-center gap-1.5 rounded-full bg-bg-hover px-3.5 text-[13px] font-medium text-text-primary">
              <RotateCcw className="h-3.5 w-3.5" /> Try again
            </button>
          )}
        </div>
        {phase === 'uploading' && (
          <div className="progress-track mt-3" role="progressbar" aria-label="Upload progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
        )}
        {phase === 'error' && error && <p className="mt-2 text-[13px] text-status-error">{error}</p>}
      </div>}
    </div>
  )
}
