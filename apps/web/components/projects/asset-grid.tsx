'use client'

import * as React from 'react'
import { LayoutGrid, List, ArrowUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/shared/badge'
import { Avatar } from '@/components/shared/avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { AssetCard } from './asset-card'
import type { Asset, AssetStatus, AssetType, User } from '@/types'
import { Layers, Film, Music, Image, Images } from 'lucide-react'

type SortKey = 'date' | 'name' | 'status'
type ViewMode = 'grid' | 'list'

const ALL_STATUSES: AssetStatus[] = ['draft', 'in_review', 'approved', 'rejected', 'archived']
const ALL_TYPES: AssetType[] = ['video', 'audio', 'image', 'image_carousel']

const typeLabels: Record<AssetType, string> = {
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
  image_carousel: 'Carousel',
}

const typeIcons: Record<AssetType, React.ElementType> = {
  video: Film,
  audio: Music,
  image: Image,
  image_carousel: Images,
}

const statusOrder: Record<AssetStatus, number> = {
  in_review: 0,
  draft: 1,
  approved: 2,
  rejected: 3,
  archived: 4,
}

interface AssetGridProps {
  assets: Asset[]
  projectId: string
  isLoading?: boolean
  assignees?: Record<string, User>
  thumbnails?: Record<string, string>
  versionCounts?: Record<string, number>
  onUpload?: () => void
  onAssetSelect?: (asset: Asset) => void
}

export function AssetGrid({
  assets,
  projectId,
  isLoading = false,
  assignees = {},
  thumbnails = {},
  versionCounts = {},
  onUpload,
  onAssetSelect,
}: AssetGridProps) {
  const [viewMode, setViewMode] = React.useState<ViewMode>('grid')
  const [sortKey, setSortKey] = React.useState<SortKey>('date')
  const [sortAsc, setSortAsc] = React.useState(false)
  const [statusFilters, setStatusFilters] = React.useState<AssetStatus[]>([])
  const [typeFilters, setTypeFilters] = React.useState<AssetType[]>([])

  const toggleStatus = (s: AssetStatus) => {
    setStatusFilters((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    )
  }

  const toggleType = (t: AssetType) => {
    setTypeFilters((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    )
  }

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc((a) => !a)
    } else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  const filtered = React.useMemo(() => {
    let result = [...assets]

    if (statusFilters.length > 0) {
      result = result.filter((a) => statusFilters.includes(a.status))
    }
    if (typeFilters.length > 0) {
      result = result.filter((a) => typeFilters.includes(a.asset_type))
    }

    result.sort((a, b) => {
      let cmp = 0
      if (sortKey === 'date') {
        cmp = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
      } else if (sortKey === 'name') {
        cmp = a.name.localeCompare(b.name)
      } else if (sortKey === 'status') {
        cmp = statusOrder[a.status] - statusOrder[b.status]
      }
      return sortAsc ? cmp : -cmp
    })

    return result
  }, [assets, statusFilters, typeFilters, sortKey, sortAsc])

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-7 w-20 animate-pulse rounded bg-bg-tertiary" />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="aspect-video animate-pulse rounded-lg bg-bg-tertiary" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Status filter chips */}
        <div className="flex flex-wrap items-center gap-1">
          {ALL_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => toggleStatus(s)}
              className={cn(
                'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors border',
                statusFilters.includes(s)
                  ? 'bg-accent text-text-inverse border-accent'
                  : 'bg-bg-secondary text-text-secondary border-border hover:bg-bg-hover',
              )}
            >
              <Badge status={s} className="pointer-events-none" />
            </button>
          ))}
        </div>

        {/* Type filter chips */}
        <div className="flex flex-wrap items-center gap-1">
          {ALL_TYPES.map((t) => {
            const TypeIcon = typeIcons[t]
            return (
              <button
                key={t}
                onClick={() => toggleType(t)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors border',
                  typeFilters.includes(t)
                    ? 'bg-accent text-text-inverse border-accent'
                    : 'bg-bg-secondary text-text-secondary border-border hover:bg-bg-hover',
                )}
              >
                <TypeIcon className="h-3 w-3" />
                {typeLabels[t]}
              </button>
            )
          })}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Sort controls */}
        <div className="flex items-center gap-1">
          {(['date', 'name', 'status'] as SortKey[]).map((key) => (
            <button
              key={key}
              onClick={() => toggleSort(key)}
              className={cn(
                'inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
                sortKey === key
                  ? 'bg-accent-muted text-accent'
                  : 'text-text-secondary hover:bg-bg-hover',
              )}
            >
              {key.charAt(0).toUpperCase() + key.slice(1)}
              {sortKey === key && (
                <ArrowUpDown className={cn('h-3 w-3', sortAsc && 'rotate-180')} />
              )}
            </button>
          ))}
        </div>

        {/* View toggle */}
        <div className="flex items-center rounded-md border border-border overflow-hidden">
          <button
            onClick={() => setViewMode('grid')}
            className={cn(
              'p-1.5 transition-colors',
              viewMode === 'grid'
                ? 'bg-accent-muted text-accent'
                : 'text-text-secondary hover:bg-bg-hover',
            )}
            aria-label="Grid view"
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={cn(
              'p-1.5 transition-colors',
              viewMode === 'list'
                ? 'bg-accent-muted text-accent'
                : 'text-text-secondary hover:bg-bg-hover',
            )}
            aria-label="List view"
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Empty state */}
      {filtered.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg-secondary">
          <EmptyState
            icon={Layers}
            title="No assets"
            description={
              statusFilters.length > 0 || typeFilters.length > 0
                ? 'No assets match the current filters.'
                : 'Upload your first asset to get started.'
            }
            action={
              !statusFilters.length && !typeFilters.length && onUpload
                ? { label: 'Upload', onClick: onUpload }
                : undefined
            }
          />
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {filtered.map((asset) => (
            <div key={asset.id} onClick={() => onAssetSelect?.(asset)} className="cursor-pointer">
              <AssetCard
                asset={asset}
                projectId={projectId}
                versionCount={versionCounts[asset.id]}
                assignee={asset.assignee_id ? assignees[asset.assignee_id] : null}
                thumbnailUrl={thumbnails[asset.id]}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          {/* List header */}
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-3 px-4 py-2 bg-bg-tertiary border-b border-border">
            <span className="text-xs font-medium text-text-secondary">Name</span>
            <span className="text-xs font-medium text-text-secondary">Status</span>
            <span className="text-xs font-medium text-text-secondary">Type</span>
            <span className="text-xs font-medium text-text-secondary">Version</span>
            <span className="text-xs font-medium text-text-secondary">Assignee</span>
          </div>
          {filtered.map((asset, i) => {
            const TypeIcon = typeIcons[asset.asset_type]
            const assignee = asset.assignee_id ? assignees[asset.assignee_id] : null
            const thumb = thumbnails[asset.id]
            return (
              <div
                key={asset.id}
                onClick={() => onAssetSelect?.(asset)}
                className={cn(
                  'grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-3 items-center px-4 py-3 transition-colors hover:bg-bg-hover cursor-pointer',
                  i !== filtered.length - 1 && 'border-b border-border',
                )}
              >
                {/* Name + thumbnail */}
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-8 w-14 shrink-0 rounded bg-bg-tertiary overflow-hidden flex items-center justify-center">
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumb} alt={asset.name} className="h-full w-full object-cover" />
                    ) : (
                      <TypeIcon className="h-4 w-4 text-text-tertiary" />
                    )}
                  </div>
                  <span className="text-sm font-medium text-text-primary line-clamp-1">
                    {asset.name}
                  </span>
                </div>
                {/* Status */}
                <div>
                  <Badge status={asset.status} />
                </div>
                {/* Type */}
                <span className="flex items-center gap-1 text-xs text-text-secondary">
                  <TypeIcon className="h-3.5 w-3.5" />
                  {typeLabels[asset.asset_type]}
                </span>
                {/* Version */}
                <span className="text-xs text-text-tertiary">
                  v{versionCounts[asset.id] ?? 1}
                </span>
                {/* Assignee */}
                <div>
                  {assignee ? (
                    <Avatar src={assignee.avatar_url} name={assignee.name} size="sm" />
                  ) : (
                    <span className="text-xs text-text-tertiary">—</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
