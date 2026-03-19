import * as React from 'react'
import { cn } from '@/lib/utils'
import type { AssetStatus } from '@/types'

interface BadgeProps {
  status: AssetStatus
  className?: string
}

const statusConfig: Record<AssetStatus, { label: string; className: string }> = {
  draft: {
    label: 'Draft',
    className: 'bg-bg-tertiary text-text-secondary border border-border',
  },
  in_review: {
    label: 'In Review',
    className: 'bg-[oklch(0.35_0.12_70/0.25)] text-status-warning border border-[oklch(0.78_0.16_70/0.3)]',
  },
  approved: {
    label: 'Approved',
    className: 'bg-[oklch(0.35_0.12_152/0.25)] text-status-success border border-[oklch(0.72_0.17_152/0.3)]',
  },
  rejected: {
    label: 'Rejected',
    className: 'bg-[oklch(0.35_0.1_25/0.25)] text-status-error border border-[oklch(0.63_0.2_25/0.3)]',
  },
  archived: {
    label: 'Archived',
    className: 'bg-bg-secondary text-text-tertiary border border-border-secondary',
  },
}

export function Badge({ status, className }: BadgeProps) {
  const config = statusConfig[status]
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium',
        config.className,
        className,
      )}
    >
      {config.label}
    </span>
  )
}
