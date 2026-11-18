'use client'

import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { formatRelativeTime } from '@/lib/utils'
import type { ShareActivityAction, ShareLinkActivity } from '@/types'

interface ShareLinkActivityPanelProps {
  token: string
}

const ACTION_LABELS: Record<ShareActivityAction, string> = {
  opened: 'Opened Share Link',
  viewed_asset: 'Viewed Asset',
  commented: 'Commented',
  approved: 'Approved',
  rejected: 'Rejected',
  downloaded: 'Downloaded',
}

// Which file a download handed out, so an owner can tell whether the master went.
const RENDITION_LABELS: Record<string, string> = {
  original: 'Original',
  transcode: 'Transcode',
}

function actionLabelColor(action: ShareActivityAction): string {
  if (action === 'approved') return 'text-status-success'
  if (action === 'rejected') return 'text-status-error'
  return 'text-text-secondary'
}

const AVATAR_COLORS = [
  'bg-violet-500',
  'bg-blue-500',
  'bg-sky-500',
  'bg-teal-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-pink-500',
  'bg-indigo-500',
]

function avatarColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

function groupByDate(activities: ShareLinkActivity[]): { label: string; items: ShareLinkActivity[] }[] {
  const groups: { label: string; items: ShareLinkActivity[] }[] = []
  const seen: Record<string, number> = {}

  for (const activity of activities) {
    const d = new Date(activity.created_at)
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    if (seen[label] === undefined) {
      seen[label] = groups.length
      groups.push({ label, items: [] })
    }
    groups[seen[label]].items.push(activity)
  }

  return groups
}

const PER_PAGE = 20

export function ShareLinkActivityPanel({ token }: ShareLinkActivityPanelProps) {
  const [activities, setActivities] = React.useState<ShareLinkActivity[]>([])
  const [page, setPage] = React.useState(1)
  const [hasMore, setHasMore] = React.useState(true)
  const [isLoading, setIsLoading] = React.useState(true)
  const [isFetchingMore, setIsFetchingMore] = React.useState(false)
  const sentinelRef = React.useRef<HTMLDivElement>(null)
  const loadedPages = React.useRef<Set<number>>(new Set())

  const fetchPage = React.useCallback(async (pageNum: number) => {
    if (loadedPages.current.has(pageNum)) return
    loadedPages.current.add(pageNum)

    if (pageNum === 1) setIsLoading(true)
    else setIsFetchingMore(true)

    try {
      const data = await api.get<ShareLinkActivity[]>(
        `/share/${token}/activity?page=${pageNum}&per_page=${PER_PAGE}`,
      )
      setActivities((prev) => pageNum === 1 ? data : [...prev, ...data])
      if (data.length < PER_PAGE) setHasMore(false)
      setPage(pageNum)
    } catch {
      loadedPages.current.delete(pageNum)
    } finally {
      setIsLoading(false)
      setIsFetchingMore(false)
    }
  }, [token])

  // Initial load
  React.useEffect(() => {
    setActivities([])
    setPage(1)
    setHasMore(true)
    loadedPages.current = new Set()
    fetchPage(1)
  }, [token, fetchPage])

  // IntersectionObserver for infinite scroll
  React.useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isFetchingMore && !isLoading) {
          fetchPage(page + 1)
        }
      },
      { threshold: 0.1 },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, isFetchingMore, isLoading, page, fetchPage])

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 animate-pulse">
            <div className="h-8 w-8 rounded-full bg-bg-tertiary shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 w-2/3 rounded bg-bg-tertiary" />
              <div className="h-2.5 w-1/3 rounded bg-bg-hover" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (activities.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
        <p className="text-sm text-text-secondary">No activity yet</p>
        <p className="mt-1 text-xs text-text-tertiary">
          Activity will appear here once someone views this share link.
        </p>
      </div>
    )
  }

  const groups = groupByDate(activities)

  return (
    <div className="py-2">
      {groups.map((group) => (
        <div key={group.label}>
          {/* Date separator */}
          <div className="sticky top-0 z-10 px-4 py-1.5 bg-bg-secondary/90 backdrop-blur-sm">
            <span className="text-2xs font-semibold uppercase tracking-wider text-text-tertiary">
              {group.label}
            </span>
          </div>

          <div className="space-y-0.5 px-3">
            {group.items.map((activity) => {
              const displayName = activity.actor_name || activity.actor_email
              const initial = displayName.charAt(0).toUpperCase()
              const colorClass = avatarColor(activity.actor_email)
              const rendition = activity.rendition ? RENDITION_LABELS[activity.rendition] : null
              const actionLabel = rendition
                ? `${ACTION_LABELS[activity.action]} (${rendition})`
                : ACTION_LABELS[activity.action]
              const actionColor = actionLabelColor(activity.action)

              return (
                <div
                  key={activity.id}
                  className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-bg-hover transition-colors"
                >
                  <div
                    className={`h-8 w-8 rounded-full ${colorClass} flex items-center justify-center shrink-0 text-white text-xs font-semibold`}
                  >
                    {initial}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                      <span className="text-sm font-medium text-text-primary truncate max-w-[140px]">
                        {displayName}
                      </span>
                      {activity.asset_name && (
                        <>
                          <span className="text-xs text-text-tertiary">on</span>
                          <span className="text-xs text-text-secondary truncate max-w-[120px]">
                            {activity.asset_name}
                          </span>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={`text-xs font-medium ${actionColor}`}>{actionLabel}</span>
                      <span className="text-text-tertiary">·</span>
                      <span className="text-xs text-text-tertiary">{formatRelativeTime(activity.created_at)}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {/* Sentinel for infinite scroll */}
      <div ref={sentinelRef} className="h-4" />

      {isFetchingMore && (
        <div className="flex justify-center py-3">
          <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
        </div>
      )}

      {!hasMore && activities.length > PER_PAGE && (
        <p className="text-center text-2xs text-text-tertiary py-3">All activity loaded</p>
      )}
    </div>
  )
}
