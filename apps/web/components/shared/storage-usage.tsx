import { cn, formatBytes, storageMeterState } from '@/lib/utils'

const FILL: Record<'ok' | 'warn' | 'critical', string> = {
  ok: 'bg-accent',
  warn: 'bg-amber-400',
  critical: 'bg-status-error',
}

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
        <div
          data-testid="storage-meter"
          className="h-1.5 w-full rounded-full bg-bg-tertiary overflow-hidden"
        >
          <div
            className={cn('h-full rounded-full transition-all duration-300', FILL[level])}
            style={{ width: `${Math.max(pct, 1)}%` }}
          />
        </div>
      )}
    </div>
  )
}
