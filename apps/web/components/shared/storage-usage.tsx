import { HardDrive } from 'lucide-react'
import { cn, formatBytes, storageMeterState } from '@/lib/utils'

const FILL: Record<'ok' | 'warn' | 'critical', string> = {
  ok: 'bg-accent',
  warn: 'bg-amber-400',
  critical: 'bg-status-error',
}

const RING_TEXT: Record<'ok' | 'warn' | 'critical', string> = {
  ok: 'text-accent',
  warn: 'text-amber-400',
  critical: 'text-status-error',
}

function usageTitle(used: number, limit: number, unlimited: boolean): string {
  return unlimited
    ? `Storage used ${formatBytes(used)}`
    : `Storage ${formatBytes(used)} / ${formatBytes(limit)}`
}

/**
 * The instance's one storage bar: track, fill, geometry and transition.
 *
 * Factored out of `StorageUsage` so the admin storage overview draws the same
 * bar for a project, an asset, a version and a file instead of a second set of
 * hand-written classes that would drift from this one. `level` picks the fill
 * from the same three-colour scale the meter uses; the overview passes `ok`,
 * because a share of a total is not a warning about anything.
 */
export function StorageBar({
  pct,
  level = 'ok',
  label,
}: {
  /** 0 to 100. Anything above 0 draws at least a sliver, so a tiny row is still visible. */
  pct: number
  level?: 'ok' | 'warn' | 'critical'
  /** Read out by assistive tech; the bar carries no text of its own. */
  label?: string
}) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      data-testid="storage-meter"
      className="h-1.5 w-full rounded-full bg-bg-tertiary overflow-hidden"
    >
      <div
        className={cn('h-full rounded-full transition-all duration-300', FILL[level])}
        style={{ width: `${clamped > 0 ? Math.max(clamped, 1) : 0}%` }}
      />
    </div>
  )
}

/** Full "used / limit" row + meter bar — for expanded surfaces (sidebar / admin panel). */
export function StorageUsage({
  used,
  limit,
  variant = 'panel',
}: {
  used: number
  limit: number
  variant?: 'sidebar' | 'panel'
}) {
  const { unlimited, pct, level } = storageMeterState(used, limit)
  const labelCls = variant === 'sidebar' ? 'text-[11px]' : 'text-sm'
  const valueCls = variant === 'sidebar' ? 'text-[10px]' : 'text-xs'

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className={cn(labelCls, 'font-medium text-text-secondary')}>
          {unlimited ? 'Storage used' : 'Storage'}
        </span>
        <span className={cn(valueCls, 'tabular-nums text-text-tertiary')}>
          {unlimited ? formatBytes(used) : `${formatBytes(used)} / ${formatBytes(limit)}`}
        </span>
      </div>
      {!unlimited && (
        <StorageBar pct={pct} level={level} label={usageTitle(used, limit, unlimited)} />
      )}
    </div>
  )
}

/** Compact circular gauge — for the collapsed sidebar rail. Ring colored by usage level
 *  when a cap is set; a plain disk icon when unlimited. Hover title shows used/limit. */
export function StorageRing({ used, limit }: { used: number; limit: number }) {
  const { unlimited, pct, level } = storageMeterState(used, limit)
  const title = usageTitle(used, limit, unlimited)

  if (unlimited) {
    return (
      <div title={title} className="flex items-center justify-center text-text-tertiary" data-testid="storage-ring-unlimited">
        <HardDrive className="h-[18px] w-[18px]" strokeWidth={1.5} />
      </div>
    )
  }

  const r = 12
  const c = 2 * Math.PI * r
  return (
    <div title={title} className={cn('relative flex items-center justify-center', RING_TEXT[level])} data-testid="storage-ring">
      <svg width="32" height="32" viewBox="0 0 32 32" className="-rotate-90">
        <circle cx="16" cy="16" r={r} fill="none" strokeWidth="2.5" className="stroke-bg-tertiary" />
        <circle
          cx="16"
          cy="16"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.max(pct, 0) / 100)}
          className="transition-all duration-300"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[8px] font-semibold tabular-nums text-text-secondary">
        {Math.round(pct)}
      </span>
    </div>
  )
}
