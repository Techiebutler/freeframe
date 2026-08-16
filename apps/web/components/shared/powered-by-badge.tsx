'use client'

import * as React from 'react'
import { useBrandingStore } from '@/stores/branding-store'
import { cn } from '@/lib/utils'

interface PoweredByBadgeProps {
  className?: string
  showOrgName?: boolean
  showIcon?: boolean
}

function FreeFrameIcon({ id }: { id: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="h-3 w-3 shrink-0"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="32" y2="32">
          <stop offset="0%" stopColor="#7c3aed" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id})`} />
      <text
        x="16"
        y="22"
        textAnchor="middle"
        fontFamily="system-ui, -apple-system, sans-serif"
        fontWeight="700"
        fontSize="17"
        fill="white"
        letterSpacing="-0.5"
      >
        FF
      </text>
    </svg>
  )
}

export function PoweredByBadge({
  className,
  showOrgName,
  showIcon = true,
}: PoweredByBadgeProps) {
  const { poweredByFreeframe, orgName } = useBrandingStore()
  const gradientId = React.useId()

  if (!poweredByFreeframe) return null

  return (
    <p
      className={cn(
        'inline-flex items-center gap-1.5 text-xs text-text-tertiary',
        className,
      )}
    >
      {showIcon && <FreeFrameIcon id={gradientId} />}
      <span>
        Powered by {showOrgName ? orgName || 'FreeFrame' : 'FreeFrame'}
      </span>
    </p>
  )
}
