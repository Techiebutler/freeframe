'use client'

import * as React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface ErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

export default function DashboardError({ error, reset }: ErrorProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center">
      {/* Icon */}
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-status-error/10">
        <AlertTriangle className="h-8 w-8 text-status-error" />
      </div>

      {/* Heading */}
      <div className="space-y-2">
        <h2 className="text-xl font-semibold text-text-primary">
          Something went wrong
        </h2>

        {/* Show error message only in development */}
        {process.env.NODE_ENV === 'development' && error?.message && (
          <p className="max-w-md rounded-lg border border-border bg-bg-secondary px-4 py-2 font-mono text-xs text-text-tertiary">
            {error.message}
          </p>
        )}

        {error?.digest && (
          <p className="text-xs text-text-tertiary">
            Error ID: <span className="font-mono">{error.digest}</span>
          </p>
        )}
      </div>

      {/* Retry button */}
      <button
        onClick={reset}
        className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-text-inverse transition-opacity hover:opacity-90"
      >
        <RefreshCw className="h-4 w-4" />
        Try again
      </button>
    </div>
  )
}
