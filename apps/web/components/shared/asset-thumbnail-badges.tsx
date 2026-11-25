import { Layers } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The version chip, top-left of a thumbnail: the same badge in the project grid
 * and in a share link's grid. Nothing below 2. The project grid passes the latest
 * version's number (numbers skip after a removed version), a share link's grid the
 * count of ready versions. `className` moves it where a grid has something else in
 * the corner.
 */
export function VersionCountBadge({ count, title, className }: { count?: number | null; title?: string; className?: string }) {
  if (!count || count <= 1) return null
  return (
    <div
      className={cn(
        'absolute top-2 left-2 flex items-center gap-1 bg-bg-primary/80 backdrop-blur-sm rounded-md px-1.5 py-0.5',
        className,
      )}
      title={title ?? `${count} versions`}
    >
      <Layers className="h-3 w-3 text-text-primary" />
      <span className="text-[10px] font-medium text-text-primary tabular-nums">{count}</span>
    </div>
  )
}

/**
 * The duration chip, bottom-right of a thumbnail, shared the same way. Nothing
 * for an image or a file whose length is not known.
 */
export function DurationBadge({ seconds }: { seconds?: number | null }) {
  if (seconds == null || seconds <= 0) return null
  return (
    <div className="absolute bottom-2 right-2 bg-bg-primary/80 backdrop-blur-sm rounded-md px-1.5 py-0.5">
      <span className="text-[10px] font-medium text-text-primary tabular-nums">
        {formatDuration(seconds)}
      </span>
    </div>
  )
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
