'use client'

import * as React from 'react'
import { X, CheckCircle, AlertCircle, Loader2, Film, Music, Image as ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/utils'
import type { UploadFile } from '@/hooks/use-upload'

function fileTypeIcon(file: File): React.ReactElement {
  const type = file.type
  if (type.startsWith('video/')) return <Film className="h-4 w-4" />
  if (type.startsWith('audio/')) return <Music className="h-4 w-4" />
  return <ImageIcon className="h-4 w-4" />
}

interface UploadItemProps {
  upload: UploadFile
  onCancel: (id: string) => void
  onRemove: (id: string) => void
}

function UploadItem({ upload, onCancel, onRemove }: UploadItemProps) {
  const canCancel = upload.status === 'pending' || upload.status === 'uploading'
  const canRemove =
    upload.status === 'complete' ||
    upload.status === 'failed' ||
    upload.status === 'cancelled'

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-bg-secondary px-3 py-2.5">
      {/* File icon */}
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-tertiary text-text-secondary">
        {fileTypeIcon(upload.file)}
      </div>

      {/* File info + progress */}
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-text-primary line-clamp-1">
            {upload.assetName}
          </p>
          <span className="shrink-0 text-xs text-text-tertiary">
            {formatBytes(upload.file.size)}
          </span>
        </div>

        {/* Progress bar */}
        {(upload.status === 'uploading' || upload.status === 'pending') && (
          <div className="h-1 w-full rounded-full bg-bg-tertiary overflow-hidden">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${upload.progress}%` }}
            />
          </div>
        )}

        {/* Status text */}
        <div className="flex items-center gap-1">
          {upload.status === 'uploading' && (
            <>
              <Loader2 className="h-3 w-3 animate-spin text-accent" />
              <span className="text-xs text-text-secondary">
                Uploading {upload.progress}%
              </span>
            </>
          )}
          {upload.status === 'pending' && (
            <span className="text-xs text-text-tertiary">Waiting...</span>
          )}
          {upload.status === 'complete' && (
            <>
              <CheckCircle className="h-3 w-3 text-status-success" />
              <span className="text-xs text-status-success">Complete</span>
            </>
          )}
          {upload.status === 'failed' && (
            <>
              <AlertCircle className="h-3 w-3 text-status-error" />
              <span className="text-xs text-status-error">
                {upload.error ?? 'Failed'}
              </span>
            </>
          )}
          {upload.status === 'cancelled' && (
            <span className="text-xs text-text-tertiary">Cancelled</span>
          )}
        </div>
      </div>

      {/* Action button */}
      {canCancel && (
        <button
          onClick={() => onCancel(upload.id)}
          className="shrink-0 text-text-tertiary hover:text-text-primary transition-colors"
          aria-label="Cancel upload"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      {canRemove && (
        <button
          onClick={() => onRemove(upload.id)}
          className="shrink-0 text-text-tertiary hover:text-text-primary transition-colors"
          aria-label="Remove"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

interface UploadProgressProps {
  uploads: UploadFile[]
  onCancel: (id: string) => void
  onRemove: (id: string) => void
  onClearCompleted?: () => void
  className?: string
}

export function UploadProgress({
  uploads,
  onCancel,
  onRemove,
  onClearCompleted,
  className,
}: UploadProgressProps) {
  if (uploads.length === 0) return null

  const completedCount = uploads.filter((u) => u.status === 'complete').length

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-text-secondary">
          {uploads.length} file{uploads.length !== 1 ? 's' : ''}
          {completedCount > 0 && ` — ${completedCount} complete`}
        </p>
        {completedCount > 0 && onClearCompleted && (
          <Button variant="ghost" size="sm" onClick={onClearCompleted}>
            Clear completed
          </Button>
        )}
      </div>

      {/* Items */}
      <div className="flex flex-col gap-2">
        {uploads.map((upload) => (
          <UploadItem
            key={upload.id}
            upload={upload}
            onCancel={onCancel}
            onRemove={onRemove}
          />
        ))}
      </div>
    </div>
  )
}
