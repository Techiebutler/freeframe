'use client'

import * as React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { X, Download, MoreHorizontal, Layers, Share2, Trash2, FolderInput, FolderIcon, Check, Film, Music, Image as ImageIcon, Images, Link as LinkIcon, Pencil } from 'lucide-react'
import { cn, formatRelativeTime, formatBytes } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Avatar } from '@/components/shared/avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { AssetCard } from './asset-card'
import { FolderCard } from './folder-card'
import { AppearancePopover } from './appearance-popover'
import { SortPopover } from './sort-popover'
import { MoveToDialog } from './move-to-dialog'
import { useViewStore } from '@/stores/view-store'
import type { Asset, AssetStatus, User, Folder, FolderTreeNode } from '@/types'

const assetTypeIcons: Record<string, React.ElementType> = {
  video: Film,
  audio: Music,
  image: ImageIcon,
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
  authorNames?: Record<string, string>
  fileSizes?: Record<string, number>
  selectedAssetId?: string | null
  onUpload?: () => void
  onAssetSelect?: (asset: Asset, e?: React.MouseEvent) => void
  onAssetOpen?: (asset: Asset) => void
  folders?: Folder[]
  currentFolderId?: string | null
  onFolderOpen?: (folder: Folder) => void
  onFolderRename?: (folderId: string, name: string) => Promise<void>
  onFolderDelete?: (folderId: string) => Promise<void>
  onFolderShare?: (folderId: string, folderName: string) => Promise<void>
  onDropToFolder?: (targetFolderId: string, assetIds: string[], folderIds: string[]) => void
  /** Share selection mode */
  shareMode?: boolean
  onShareModeChange?: (active: boolean) => void
  onCreateShareLink?: (selectedAssetIds: string[], selectedFolderIds: string[]) => void
  /** Bulk actions */
  onBulkDelete?: (assetIds: string[], folderIds: string[]) => void
  onBulkMove?: (assetIds: string[], folderIds: string[], targetFolderId: string | null) => void
  onBulkDownload?: (assetIds: string[], folderIds: string[]) => void
  projectName?: string
  folderTree?: FolderTreeNode[]
  onAssetShare?: (asset: Asset) => void
  onAssetDownload?: (asset: Asset) => void
  onAssetRename?: (asset: Asset) => void
  onAssetDelete?: (asset: Asset) => void
  /** Actions rendered on the right side of the navigator bar */
  actions?: React.ReactNode
}

// Grid column classes based on card size
const gridColsMap = {
  S: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5',
  M: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  L: 'grid-cols-1 sm:grid-cols-1 lg:grid-cols-2',
}

// Aspect ratio classes
const aspectMap = {
  landscape: 'aspect-[16/10]',
  square: 'aspect-square',
  portrait: 'aspect-[3/4]',
}

export function AssetGrid({
  assets,
  projectId,
  isLoading = false,
  assignees = {},
  thumbnails = {},
  versionCounts = {},
  authorNames = {},
  fileSizes = {},
  selectedAssetId,
  onUpload,
  onAssetSelect,
  onAssetOpen,
  folders,
  currentFolderId,
  onFolderOpen,
  onFolderRename,
  onFolderDelete,
  onFolderShare,
  onDropToFolder,
  shareMode = false,
  onShareModeChange,
  onCreateShareLink,
  onBulkDelete,
  onBulkMove,
  onBulkDownload,
  projectName = 'Project',
  folderTree = [],
  onAssetShare,
  onAssetDownload,
  onAssetRename,
  onAssetDelete,
  actions,
}: AssetGridProps) {
  const [selectedAssetIds, setSelectedAssetIds] = React.useState<Set<string>>(new Set())
  const [selectedFolderIds, setSelectedFolderIds] = React.useState<Set<string>>(new Set())
  const [moveDialogOpen, setMoveDialogOpen] = React.useState(false)

  // Legacy alias
  const selectedIds = selectedAssetIds

  // Clear selection when share mode changes
  React.useEffect(() => {
    if (!shareMode) return
    setSelectedAssetIds(new Set())
    setSelectedFolderIds(new Set())
  }, [shareMode])

  const {
    layout,
    cardSize,
    aspectRatio,
    thumbnailScale,
    showCardInfo,
    titleLines,
    flattenFolders,
    showFileSize,
    showUploader,
    sortKey,
    sortDirection,
  } = useViewStore()

  const toggleAssetSelect = (assetId: string) => {
    setSelectedAssetIds((prev) => {
      const next = new Set(prev)
      if (next.has(assetId)) next.delete(assetId)
      else next.add(assetId)
      return next
    })
  }

  const toggleFolderSelect = (folderId: string) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  const clearSelection = () => {
    setSelectedAssetIds(new Set())
    setSelectedFolderIds(new Set())
  }

  const totalSelected = selectedAssetIds.size + selectedFolderIds.size
  const selectedTotalSize = Array.from(selectedAssetIds).reduce((sum, id) => sum + (fileSizes[id] ?? 0), 0)

  const filtered = React.useMemo(() => {
    let result = [...assets]

    if (sortKey !== 'custom') {
      result.sort((a, b) => {
        let cmp = 0
        if (sortKey === 'date') {
          cmp = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
        } else if (sortKey === 'name') {
          cmp = a.name.localeCompare(b.name)
        } else if (sortKey === 'status') {
          cmp = statusOrder[a.status] - statusOrder[b.status]
        } else if (sortKey === 'type') {
          cmp = a.asset_type.localeCompare(b.asset_type)
        }
        return sortDirection === 'asc' ? cmp : -cmp
      })
    }

    return result
  }, [assets, sortKey, sortDirection])

  const showFolders = !flattenFolders && folders && folders.length > 0

  if (isLoading) {
    return (
      <div className={cn('grid gap-4', gridColsMap[cardSize])}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className={cn('animate-pulse rounded-lg bg-bg-tertiary', aspectMap[aspectRatio])} />
            <div className="h-4 w-3/4 animate-pulse rounded bg-bg-tertiary" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-bg-tertiary" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 relative">
      {/* ─── Share Selection Mode Bar ──────────────────────────────────── */}
      {shareMode && (
        <div className="flex items-center justify-between rounded-lg border border-accent/30 bg-accent/5 px-4 py-2.5">
          <span className="text-sm font-medium text-text-primary">
            Select items to share
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                clearSelection()
                onShareModeChange?.(false)
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={totalSelected === 0}
              onClick={() => {
                onCreateShareLink?.(Array.from(selectedAssetIds), Array.from(selectedFolderIds))
                clearSelection()
                onShareModeChange?.(false)
              }}
            >
              Create Share Link
            </Button>
          </div>
        </div>
      )}

      {/* ─── Navigator Bar (Frame.io style) ─────────────────────────────── */}
      {!shareMode && (
        <div className="flex items-center gap-1 border-b border-border pb-2.5">
          {/* Left group: Appearance + Fields + Sort */}
          <AppearancePopover />

          <div className="h-4 w-px bg-border mx-0.5" />

          <SortPopover />

          <div className="flex-1" />

          {/* Right group: action buttons passed from parent */}
          {actions && (
            <div className="flex items-center gap-2">
              {actions}
            </div>
          )}
        </div>
      )}

      {/* ─── Grid view: folders section ──────────────────────────────── */}
      {showFolders && layout === 'grid' && (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-tertiary font-medium uppercase tracking-wider">
              {folders!.length} {folders!.length === 1 ? 'Folder' : 'Folders'}
            </span>
          </div>
          <div className={cn('grid gap-3', gridColsMap[cardSize])}>
            {folders!.map((folder) => {
              const isFolderSelected = selectedFolderIds.has(folder.id)
              return (
                <div
                  key={folder.id}
                  className={cn(
                    'group/folder relative',
                    isFolderSelected && 'ring-2 ring-accent rounded-lg',
                  )}
                  onClick={shareMode ? (e) => { e.stopPropagation(); toggleFolderSelect(folder.id) } : undefined}
                >
                  <button
                    className={cn(
                      'absolute top-2 left-2 z-10 h-5 w-5 rounded border flex items-center justify-center transition-all',
                      isFolderSelected
                        ? 'bg-accent border-accent text-white opacity-100'
                        : 'bg-black/40 border-white/30 text-transparent opacity-0 group-hover/folder:opacity-100',
                    )}
                    onClick={(e) => { e.stopPropagation(); toggleFolderSelect(folder.id) }}
                  >
                    {isFolderSelected && <Check className="h-3 w-3" />}
                  </button>
                  <FolderCard
                    folder={folder}
                    onOpen={shareMode ? () => {} : onFolderOpen!}
                    onRename={shareMode ? undefined : onFolderRename}
                    onDelete={shareMode ? undefined : onFolderDelete}
                    onShare={shareMode ? undefined : onFolderShare}
                    onDropItems={shareMode ? undefined : onDropToFolder}
                  />
                </div>
              )
            })}
          </div>
          {filtered.length > 0 && (
            <div className="flex items-center gap-2 mt-2">
              <span className="text-xs text-text-tertiary font-medium uppercase tracking-wider">
                {filtered.length} {filtered.length === 1 ? 'Asset' : 'Assets'}
              </span>
            </div>
          )}
        </>
      )}

      {/* ─── Assets (grid) ───────────────────────────────────────────── */}
      {filtered.length === 0 && !showFolders ? (
        <div className="rounded-lg border border-border bg-bg-secondary">
          <EmptyState
            icon={Layers}
            title="No assets"
            description="Upload your first asset to get started."
            action={onUpload ? { label: 'Upload', onClick: onUpload } : undefined}
          />
        </div>
      ) : layout === 'grid' && filtered.length > 0 ? (
        <div className={cn('grid gap-3', gridColsMap[cardSize])}>
          {filtered.map((asset) => (
            <div
              key={asset.id}
              className={cn(
                'rounded-lg transition-all cursor-pointer',
                selectedAssetId === asset.id && 'ring-2 ring-accent ring-offset-1 ring-offset-bg-primary',
              )}
              onClick={(e) => onAssetSelect?.(asset, e)}
              onDoubleClick={() => onAssetOpen?.(asset)}
            >
              <AssetCard
                asset={asset}
                projectId={projectId}
                versionCount={versionCounts[asset.id]}
                assignee={asset.assignee_id ? assignees[asset.assignee_id] : null}
                authorName={authorNames[asset.created_by]}
                thumbnailUrl={thumbnails[asset.id]}
                fileSize={fileSizes[asset.id] ?? null}
                selected={selectedAssetIds.has(asset.id)}
                onSelect={() => toggleAssetSelect(asset.id)}
                showInfo={showCardInfo}
                showFileSize={showFileSize}
                showUploader={showUploader}
                titleLines={titleLines}
                aspectRatio={aspectRatio}
                thumbnailScale={thumbnailScale}
                onShare={onAssetShare ? () => onAssetShare(asset) : undefined}
                onDownload={onAssetDownload ? () => onAssetDownload(asset) : undefined}
                onRename={onAssetRename ? () => onAssetRename(asset) : undefined}
                onDelete={onAssetDelete ? () => onAssetDelete(asset) : undefined}
                onDragStart={(e: React.DragEvent) => {
                  const ids = selectedAssetIds.has(asset.id)
                    ? Array.from(selectedIds)
                    : [asset.id]
                  e.dataTransfer.setData(
                    'application/json',
                    JSON.stringify({ assetIds: ids, folderIds: [] }),
                  )
                  e.dataTransfer.effectAllowed = 'move'
                }}
              />
            </div>
          ))}
        </div>
      ) : layout === 'list' && (showFolders || filtered.length > 0) ? (
        /* ─── Unified list view (folders + assets) ─────────────────── */
        <div className="rounded-lg border border-border overflow-hidden">
          {/* Column headers */}
          <div className="flex items-center gap-4 px-3 py-2 border-b border-border bg-bg-secondary/50 text-[10px] text-text-tertiary font-medium uppercase tracking-wider">
            <div className="h-10 w-10 shrink-0" />
            <div className="flex-1 min-w-0">Name</div>
            {showUploader && <div className="hidden md:block w-32">Uploader</div>}
            {showFileSize && <div className="hidden sm:block w-24 text-right">Size</div>}
            <div className="hidden md:block w-10 text-center">Ver.</div>
            <div className="hidden sm:block w-28">Date</div>
            <div className="w-8 shrink-0" />
            <div className="w-8 shrink-0" />
          </div>

          {/* Folder rows */}
          {showFolders && folders!.map((folder, i) => {
            const isFolderSelected = selectedFolderIds.has(folder.id)
            return (
              <div
                key={folder.id}
                className={cn(
                  'group flex items-center gap-4 px-3 py-2.5 transition-colors hover:bg-bg-hover cursor-pointer',
                  i !== folders!.length - 1 || filtered.length > 0 ? 'border-b border-border' : '',
                  isFolderSelected && 'bg-accent/5',
                )}
                onClick={() => onFolderOpen?.(folder)}
                onDoubleClick={() => onFolderOpen?.(folder)}
              >
                {/* Folder icon with checkbox overlay — aligned with asset thumbnail */}
                <div className="relative h-10 w-10 shrink-0 rounded-md bg-bg-tertiary flex items-center justify-center overflow-hidden">
                  <FolderIcon className="h-5 w-5 text-text-tertiary/60" />
                  <button
                    className={cn(
                      'absolute inset-0 flex items-center justify-center transition-all',
                      isFolderSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                    )}
                    onClick={(e) => { e.stopPropagation(); toggleFolderSelect(folder.id) }}
                  >
                    <div className={cn(
                      'h-4 w-4 rounded border flex items-center justify-center transition-all',
                      isFolderSelected
                        ? 'bg-accent border-accent text-white'
                        : 'bg-black/40 border-white/40 text-transparent',
                    )}>
                      {isFolderSelected && <Check className="h-2.5 w-2.5" />}
                    </div>
                  </button>
                </div>

                {/* Name */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate leading-snug">{folder.name}</p>
                  <p className="text-xs text-text-tertiary mt-0.5">{folder.item_count ?? 0} item{(folder.item_count ?? 0) !== 1 ? 's' : ''}</p>
                </div>

                {/* Uploader placeholder */}
                {showUploader && <div className="hidden md:block w-32 text-xs text-text-tertiary">—</div>}

                {/* Size placeholder */}
                {showFileSize && <div className="hidden sm:block w-24 text-right text-sm text-text-tertiary">—</div>}

                {/* Version placeholder */}
                <div className="hidden md:block w-10 text-center text-xs text-text-tertiary">—</div>

                {/* Date */}
                <div className="hidden sm:block w-28 text-xs text-text-tertiary shrink-0">
                  {new Date(folder.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>

                {/* Assignee placeholder — keeps column alignment */}
                <div className="w-8 shrink-0" />

                {/* Context menu */}
                <div className="w-8 shrink-0 flex justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        className="flex h-6 w-6 items-center justify-center rounded hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors outline-none"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        align="end"
                        sideOffset={4}
                        className="z-[100] min-w-[160px] rounded-xl border border-border bg-bg-elevated shadow-2xl py-1.5 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {onFolderShare && (
                          <DropdownMenu.Item
                            onSelect={() => onFolderShare(folder.id, folder.name)}
                            className="flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                          >
                            <Share2 className="h-3.5 w-3.5 text-text-tertiary" />
                            Share
                          </DropdownMenu.Item>
                        )}
                        {onFolderRename && (
                          <DropdownMenu.Item
                            onSelect={() => onFolderRename(folder.id, folder.name)}
                            className="flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                          >
                            <Pencil className="h-3.5 w-3.5 text-text-tertiary" />
                            Rename
                          </DropdownMenu.Item>
                        )}
                        {onFolderDelete && (
                          <DropdownMenu.Item
                            onSelect={() => onFolderDelete(folder.id)}
                            className="flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-status-error hover:bg-status-error/10 cursor-pointer outline-none transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete
                          </DropdownMenu.Item>
                        )}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
              </div>
            )
          })}
          {filtered.map((asset, i) => {
            const thumb = thumbnails[asset.id]
            const assignee = asset.assignee_id ? assignees[asset.assignee_id] : null
            const fileSize = fileSizes[asset.id]
            const versionCount = versionCounts[asset.id]
            const author = authorNames[asset.created_by]
            const TypeIcon = assetTypeIcons[asset.asset_type] ?? ImageIcon
            return (
              <div
                key={asset.id}
                onClick={(e) => onAssetSelect?.(asset, e)}
                onDoubleClick={() => onAssetOpen?.(asset)}
                className={cn(
                  'group flex items-center gap-4 px-3 py-2 transition-colors hover:bg-bg-hover cursor-pointer',
                  i !== filtered.length - 1 && 'border-b border-border',
                  selectedAssetId === asset.id ? 'bg-accent/10' : selectedAssetIds.has(asset.id) && 'bg-accent/5',
                )}
              >
                {/* Square thumbnail with checkbox overlay */}
                <div className="relative h-10 w-10 shrink-0 rounded-md bg-bg-tertiary overflow-hidden flex items-center justify-center">
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumb} alt={asset.name} className="h-full w-full object-cover" />
                  ) : (
                    <TypeIcon className="h-6 w-6 text-text-tertiary/60" />
                  )}
                  <button
                    className={cn(
                      'absolute inset-0 flex items-center justify-center transition-all',
                      selectedAssetIds.has(asset.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                    )}
                    onClick={(e) => { e.stopPropagation(); toggleAssetSelect(asset.id) }}
                  >
                    <div className={cn(
                      'h-4 w-4 rounded border flex items-center justify-center transition-all',
                      selectedAssetIds.has(asset.id)
                        ? 'bg-accent border-accent text-white'
                        : 'bg-black/40 border-white/40 text-transparent',
                    )}>
                      {selectedAssetIds.has(asset.id) && <Check className="h-2.5 w-2.5" />}
                    </div>
                  </button>
                </div>
                {/* Name + status */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate leading-snug">{asset.name}</p>
                </div>
                {/* Uploader */}
                {showUploader && (
                  <div className="hidden md:block w-32 text-xs text-text-tertiary truncate shrink-0">
                    {author || '—'}
                  </div>
                )}
                {/* File size */}
                {showFileSize && (
                  <div className="hidden sm:block w-24 text-right text-sm text-text-tertiary tabular-nums shrink-0">
                    {fileSize ? formatBytes(fileSize) : '—'}
                  </div>
                )}
                {/* Version */}
                <div className="hidden md:block w-10 text-center text-xs text-text-tertiary tabular-nums shrink-0">
                  {versionCount ? `v${versionCount}` : 'v1'}
                </div>
                {/* Date */}
                <div className="hidden sm:block w-28 text-xs text-text-tertiary shrink-0">
                  {new Date(asset.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
                {/* Assignee */}
                <div className="w-8 shrink-0 flex justify-center">
                  {assignee && <Avatar src={assignee.avatar_url} name={assignee.name} size="sm" />}
                </div>
                {/* Context menu — hidden until hover */}
                <div className="w-8 shrink-0 flex justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        className="flex h-6 w-6 items-center justify-center rounded hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors outline-none"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        align="end"
                        sideOffset={4}
                        className="z-[100] min-w-[200px] rounded-xl border border-border bg-bg-elevated shadow-2xl py-1.5 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <DropdownMenu.Item
                          onSelect={() => onAssetShare?.(asset)}
                          className="flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                        >
                          <Share2 className="h-3.5 w-3.5 text-text-tertiary" />
                          Create Share Link
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator className="my-1 h-px bg-border mx-1" />
                        <DropdownMenu.Item
                          onSelect={() => onAssetDownload?.(asset)}
                          className="flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                        >
                          <Download className="h-3.5 w-3.5 text-text-tertiary" />
                          Download
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          onSelect={() => {
                            const url = `${window.location.origin}/projects/${asset.project_id}/assets/${asset.id}`
                            navigator.clipboard.writeText(url)
                          }}
                          className="flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                        >
                          <LinkIcon className="h-3.5 w-3.5 text-text-tertiary" />
                          Copy Asset URL
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator className="my-1 h-px bg-border mx-1" />
                        <DropdownMenu.Item
                          onSelect={() => onAssetRename?.(asset)}
                          className="flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                        >
                          <Pencil className="h-3.5 w-3.5 text-text-tertiary" />
                          Rename
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          onSelect={() => onAssetDelete?.(asset)}
                          className="flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-status-error hover:bg-status-error/10 cursor-pointer outline-none transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}

      {/* Bottom selection action bar (Frame.io style) */}
      {!shareMode && totalSelected > 0 && (
        <div className="sticky bottom-0 z-20 flex items-center gap-3 rounded-lg border border-border bg-bg-elevated px-4 py-2.5 shadow-xl">
          <button onClick={clearSelection} className="text-text-tertiary hover:text-text-primary transition-colors">
            <X className="h-4 w-4" />
          </button>
          <span className="text-sm text-text-primary font-medium">
            {totalSelected} Item{totalSelected !== 1 ? 's' : ''} selected
          </span>
          {selectedTotalSize > 0 && (
            <span className="text-xs text-text-tertiary">
              &middot; {formatBytes(selectedTotalSize)}
            </span>
          )}
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => onBulkDelete?.(Array.from(selectedAssetIds), Array.from(selectedFolderIds))}
          >
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
          {onBulkMove && (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setMoveDialogOpen(true)}>
              <FolderInput className="h-4 w-4" /> Move to
            </Button>
          )}
          {onCreateShareLink && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                onCreateShareLink(Array.from(selectedAssetIds), Array.from(selectedFolderIds))
                clearSelection()
              }}
            >
              <Share2 className="h-4 w-4" /> Share
            </Button>
          )}
          {selectedAssetIds.size > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => onBulkDownload?.(Array.from(selectedAssetIds), Array.from(selectedFolderIds))}
            >
              <Download className="h-4 w-4" /> Download
            </Button>
          )}
        </div>
      )}

      <MoveToDialog
        open={moveDialogOpen}
        onOpenChange={setMoveDialogOpen}
        projectName={projectName}
        tree={folderTree}
        currentFolderId={currentFolderId ?? null}
        movingFolderIds={Array.from(selectedFolderIds)}
        onMove={(targetFolderId) => {
          onBulkMove?.(Array.from(selectedAssetIds), Array.from(selectedFolderIds), targetFolderId)
          clearSelection()
        }}
      />
    </div>
  )
}
