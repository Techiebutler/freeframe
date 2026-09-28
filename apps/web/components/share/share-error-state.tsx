'use client'

import { AlertTriangle, Clock, RefreshCw } from 'lucide-react'
import { PoweredByBadge } from '@/components/shared/powered-by-badge'

interface ShareErrorStateProps {
  expired?: boolean
  unavailable?: boolean
}

/**
 * The share page's dead-end screen, factored out so the short-link route can
 * show the same thing when a code does not resolve (instead of bouncing an
 * anonymous visitor to the login page with no explanation).
 *
 * `unavailable` is the retry screen: shown when the lookup itself failed
 * (network, timeout, rate limit, 5xx) rather than the link being unknown.
 */
export function ShareErrorState({ expired, unavailable }: ShareErrorStateProps) {
  const title = unavailable ? 'Please try again' : expired ? 'Link expired' : 'Link not found'
  const message = unavailable
    ? 'This link could not be checked right now. Refresh the page in a moment.'
    : expired
      ? 'This share link has expired and is no longer accessible.'
      : 'This share link is invalid or has been removed.'

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary p-6 text-center shadow-xl">
        <div className="mb-4 flex justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-status-error/10">
            {unavailable ? (
              <RefreshCw className="h-6 w-6 text-status-error" />
            ) : expired ? (
              <Clock className="h-6 w-6 text-status-error" />
            ) : (
              <AlertTriangle className="h-6 w-6 text-status-error" />
            )}
          </div>
        </div>
        <h1 className="text-sm font-semibold text-text-primary">{title}</h1>
        <p className="mt-1 text-xs text-text-tertiary">{message}</p>
        <PoweredByBadge className="mt-6" showOrgName />
      </div>
    </div>
  )
}
