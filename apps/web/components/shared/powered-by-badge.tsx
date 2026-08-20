'use client'

import * as React from 'react'
import { useBrandingStore } from '@/stores/branding-store'
import { cn } from '@/lib/utils'

interface PoweredByBadgeProps {
  className?: string
  showOrgName?: boolean
  showIcon?: boolean
}

/** The FreeFrame mark on its own: the exact artwork the favicon uses
 *  (public/logo-icon.png is byte-identical to app/icon.png), with no wordmark,
 *  since the line already reads "Powered by FreeFrame". Two files rather than
 *  one because the mark is a flat silhouette, so it needs inverting per theme —
 *  the same logo-dark/logo-light pair the sidebar uses. */
function FreeFrameMark() {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-icon.png" alt="" aria-hidden="true" className="logo-dark h-3.5 w-3.5 shrink-0 object-contain" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-icon-dark.png" alt="" aria-hidden="true" className="logo-light h-3.5 w-3.5 shrink-0 object-contain" />
    </>
  )
}

const FREEFRAME_REPO_URL = 'https://github.com/Techiebutler/freeframe'

export function PoweredByBadge({
  className,
  showOrgName,
  showIcon = true,
}: PoweredByBadgeProps) {
  const { poweredByFreeframe, orgName } = useBrandingStore()

  if (!poweredByFreeframe) return null

  const classes = cn(
    'inline-flex items-center gap-1.5 text-xs text-text-tertiary',
    className,
  )
  const content = (
    <>
      {showIcon && <FreeFrameMark />}
      <span>
        Powered by {showOrgName ? orgName || 'FreeFrame' : 'FreeFrame'}
      </span>
    </>
  )

  // Only the FreeFrame credit links out. With showOrgName the line reads
  // "Powered by <the org>", and pointing that at FreeFrame's repository would
  // send people somewhere the text never promised.
  if (showOrgName) {
    return <p className={classes}>{content}</p>
  }

  return (
    <a
      href={FREEFRAME_REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      title="FreeFrame on GitHub"
      className={cn(classes, 'transition-colors hover:text-text-secondary')}
    >
      {content}
    </a>
  )
}
