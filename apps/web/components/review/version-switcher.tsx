'use client'

import * as React from 'react'
import { GitCompare, AlertCircle, Loader2, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useReviewStore } from '@/stores/review-store'
import type { AssetVersion, AssetVersionStatus } from '@/types'

// ─── Version status badge ─────────────────────────────────────────────────────

const versionStatusConfig: Record<
  AssetVersionStatus,
  { label: string; className: string; icon: React.ReactNode }
> = {
  uploading: {
    label: 'Uploading',
    className: 'text-status-info',
    icon: <Loader2 className="h-2.5 w-2.5 animate-spin" />,
  },
  processing: {
    label: 'Processing',
    className: 'text-status-warning',
    icon: <Loader2 className="h-2.5 w-2.5 animate-spin" />,
  },
  ready: {
    label: 'Ready',
    className: 'text-status-success',
    icon: <CheckCircle2 className="h-2.5 w-2.5" />,
  },
  failed: {
    label: 'Failed',
    className: 'text-status-error',
    icon: <AlertCircle className="h-2.5 w-2.5" />,
  },
}

function VersionStatusDot({ status }: { status: AssetVersionStatus }) {
  const config = versionStatusConfig[status]
  return (
    <span
      className={cn('inline-flex items-center gap-0.5', config.className)}
      title={config.label}
    >
      {config.icon}
    </span>
  )
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface VersionSwitcherProps {
  versions: AssetVersion[]
  className?: string
  /** Controlled compare mode from parent; if omitted, uses internal state */
  compareMode?: boolean
  onCompareModeChange?: (enabled: boolean) => void
}

// ─── Component ────────────────────────────────────────────────────────────────

export function VersionSwitcher({
  versions,
  className,
  compareMode: externalCompareMode,
  onCompareModeChange,
}: VersionSwitcherProps) {
  const currentVersion = useReviewStore((s) => s.currentVersion)
  const setCurrentVersion = useReviewStore((s) => s.setCurrentVersion)

  const [internalCompareMode, setInternalCompareMode] = React.useState(false)
  const compareMode = externalCompareMode !== undefined ? externalCompareMode : internalCompareMode

  function toggleCompare() {
    const next = !compareMode
    if (onCompareModeChange) {
      onCompareModeChange(next)
    } else {
      setInternalCompareMode(next)
    }
  }

  // Sort versions ascending by version_number
  const sorted = React.useMemo(
    () => [...versions].sort((a, b) => a.version_number - b.version_number),
    [versions],
  )

  if (sorted.length === 0) return null

  return (
    <div
      className={cn(
        'flex items-center gap-1 overflow-x-auto px-4 py-2 border-b border-border bg-bg-secondary',
        className,
      )}
    >
      {/* Label */}
      <span className="text-2xs text-text-tertiary shrink-0 mr-1">Version:</span>

      {/* Version tabs */}
      <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto">
        {sorted.map((version) => {
          const isActive = currentVersion?.id === version.id
          const statusCfg = versionStatusConfig[version.processing_status]

          return (
            <button
              key={version.id}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors shrink-0',
                isActive
                  ? 'bg-accent text-text-inverse'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                version.processing_status === 'failed' && !isActive && 'text-status-error',
                version.processing_status === 'processing' && !isActive && 'text-status-warning',
              )}
              onClick={() => setCurrentVersion(version)}
              disabled={version.processing_status === 'uploading' || version.processing_status === 'processing'}
              title={`Version ${version.version_number} — ${statusCfg.label}`}
            >
              <span>v{version.version_number}</span>
              <VersionStatusDot status={version.processing_status} />
            </button>
          )
        })}
      </div>

      {/* Compare toggle */}
      {sorted.length > 1 && (
        <button
          className={cn(
            'ml-2 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors shrink-0',
            compareMode
              ? 'bg-accent-muted text-accent border border-accent/30'
              : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary border border-transparent',
          )}
          onClick={toggleCompare}
          title={compareMode ? 'Exit compare mode' : 'Compare versions side by side'}
        >
          <GitCompare className="h-3.5 w-3.5" />
          Compare
        </button>
      )}
    </div>
  )
}
