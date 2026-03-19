'use client'

import * as React from 'react'
import { LayoutGrid, List, ArrowUpDown, Search, Plus, X, Copy, Download, MoreHorizontal } from 'lucide-react'
import { cn, formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/shared/badge'
import { Avatar } from '@/components/shared/avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { AssetCard } from './asset-card'
import type { Asset, AssetStatus, AssetType, User } from '@/types'
import { Layers } from 'lucide-react'

type SortKey = 'date' | 'name' | 'status'
type ViewMode = 'grid' | 'list'

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
  authorNames?: Record<string, string>
  onUpload?: () => void
  onAssetSelect?: (asset: Asset) => void
  onAssetClick?: (asset: Asset) => void
}

export function AssetGrid({
  assets,
  projectId,
  isLoading = false,
  assignees = {},
  thumbnails = {},
  versionCounts = {},
  authorNames = {},
  onUpload,
  onAssetSelect,
  onAssetClick,
}: AssetGridProps) {
  const [viewMode, setViewMode] = React.useState<ViewMode>('grid')
  const [sortKey, setSortKey] = React.useState<SortKey>('date')
  const [sortAsc, setSortAsc] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [showSearch, setShowSearch] = React.useState(false)
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc((a) => !a)
    } else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  const toggleSelect = (assetId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(assetId)) next.delete(assetId)
      else next.add(assetId)
      return next
    })
  }

  const clearSelection = () => setSelectedIds(new Set())

  const filtered = React.useMemo(() => {
    let result = [...assets]

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter((a) => a.name.toLowerCase().includes(q))
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
  }, [assets, searchQuery, sortKey, sortAsc])

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="aspect-[4/3] animate-pulse rounded-lg bg-bg-tertiary" />
            <div className="h-4 w-3/4 animate-pulse rounded bg-bg-tertiary" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-bg-tertiary" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar — clean, Frame.io-style */}
      <div className="flex items-center gap-2">
        {/* Sort dropdown */}
        <div className="flex items-center gap-1 rounded-md border border-border bg-bg-secondary px-2 py-1">
          <span className="text-2xs text-text-tertiary">Sorted by</span>
          {(['date', 'name', 'status'] as SortKey[]).map((key) => (
            <button
              key={key}
              onClick={() => toggleSort(key)}
              className={cn(
                'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs transition-colors',
                sortKey === key
                  ? 'text-text-primary font-medium'
                  : 'text-text-tertiary hover:text-text-secondary',
              )}
            >
              {key.charAt(0).toUpperCase() + key.slice(1)}
              {sortKey === key && (
                <ArrowUpDown className={cn('h-3 w-3', sortAsc && 'rotate-180')} />
              )}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Search */}
        {showSearch ? (
          <div className="flex items-center gap-1 rounded-md border border-border bg-bg-secondary px-2 py-1">
            <Search className="h-3.5 w-3.5 text-text-tertiary" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter assets..."
              className="bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none w-40"
              autoFocus
            />
            <button
              onClick={() => { setShowSearch(false); setSearchQuery('') }}
              className="text-text-tertiary hover:text-text-primary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowSearch(true)}
            className="h-7 w-7 flex items-center justify-center rounded text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
          >
            <Search className="h-4 w-4" />
          </button>
        )}

        {/* Add button */}
        {onUpload && (
          <button
            onClick={onUpload}
            className="h-7 w-7 flex items-center justify-center rounded text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
          >
            <Plus className="h-4 w-4" />
          </button>
        )}

        {/* View toggle */}
        <div className="flex items-center rounded border border-border overflow-hidden">
          <button
            onClick={() => setViewMode('grid')}
            className={cn(
              'p-1 transition-colors',
              viewMode === 'grid' ? 'bg-bg-hover text-text-primary' : 'text-text-tertiary hover:text-text-secondary',
            )}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={cn(
              'p-1 transition-colors',
              viewMode === 'list' ? 'bg-bg-hover text-text-primary' : 'text-text-tertiary hover:text-text-secondary',
            )}
          >
            <List className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Grid / List */}
      {filtered.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg-secondary">
          <EmptyState
            icon={Layers}
            title="No assets"
            description={searchQuery ? 'No assets match your search.' : 'Upload your first asset to get started.'}
            action={!searchQuery && onUpload ? { label: 'Upload', onClick: onUpload } : undefined}
          />
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((asset) => (
            <div
              key={asset.id}
              onClick={() => onAssetSelect?.(asset)}
            >
              <AssetCard
                asset={asset}
                projectId={projectId}
                versionCount={versionCounts[asset.id]}
                assignee={asset.assignee_id ? assignees[asset.assignee_id] : null}
                authorName={authorNames[asset.created_by]}
                thumbnailUrl={thumbnails[asset.id]}
                selected={selectedIds.has(asset.id)}
                onSelect={() => toggleSelect(asset.id)}
              />
            </div>
          ))}
        </div>
      ) : (
        /* List view */
        <div className="rounded-lg border border-border overflow-hidden">
          {filtered.map((asset, i) => {
            const thumb = thumbnails[asset.id]
            const assignee = asset.assignee_id ? assignees[asset.assignee_id] : null
            return (
              <div
                key={asset.id}
                onClick={() => onAssetSelect?.(asset)}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-bg-hover cursor-pointer',
                  i !== filtered.length - 1 && 'border-b border-border',
                  selectedIds.has(asset.id) && 'bg-accent/5',
                )}
              >
                {/* Thumbnail */}
                <div className="h-10 w-16 shrink-0 rounded bg-bg-tertiary overflow-hidden flex items-center justify-center">
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumb} alt={asset.name} className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-2xs text-text-tertiary uppercase font-bold">{asset.asset_type}</span>
                  )}
                </div>
                {/* Name + meta */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate">{asset.name}</p>
                  <p className="text-2xs text-text-tertiary">
                    {authorNames[asset.created_by] && <>{authorNames[asset.created_by]} &bull; </>}
                    {formatRelativeTime(asset.created_at)}
                  </p>
                </div>
                <Badge status={asset.status} />
                {assignee && <Avatar src={assignee.avatar_url} name={assignee.name} size="sm" />}
              </div>
            )
          })}
        </div>
      )}

      {/* Bottom selection bar */}
      {selectedIds.size > 0 && (
        <div className="sticky bottom-0 z-20 flex items-center gap-3 rounded-lg border border-border bg-bg-elevated px-4 py-2.5 shadow-xl">
          <button onClick={clearSelection} className="text-text-tertiary hover:text-text-primary transition-colors">
            <X className="h-4 w-4" />
          </button>
          <span className="text-sm text-text-primary font-medium">
            {selectedIds.size} asset{selectedIds.size !== 1 ? 's' : ''} selected
          </span>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" className="gap-1.5">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" className="gap-1.5">
            <Copy className="h-4 w-4" /> Copy to
          </Button>
          <Button variant="ghost" size="sm" className="gap-1.5">
            <Download className="h-4 w-4" /> Download
          </Button>
        </div>
      )}
    </div>
  )
}
