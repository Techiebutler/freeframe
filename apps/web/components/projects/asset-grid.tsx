'use client'

import * as React from 'react'
import { X, Download, MoreHorizontal, Layers, Share2, Trash2, FolderInput, FolderIcon, Check, Film, Music, Image as ImageIcon, Images } from 'lucide-react'
import { cn, formatBytes } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Avatar } from '@/components/shared/avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { ContextMenuArea, DotsMenu } from '@/components/shared/item-menu'
import { AssetCard } from './asset-card'
import { FolderCard } from './folder-card'
import { AssetMenuItems } from './menus/asset-menu'
import { WithFolderMenu } from './menus/folder-menu'
import { SelectionMenuItems, type SelectionActions } from './menus/selection-menu'
import { AppearancePopover } from './appearance-popover'
import { SortPopover } from './sort-popover'
import { MoveToDialog } from './move-to-dialog'
import { useViewStore } from '@/stores/view-store'
import { sortAssets } from '@/lib/sort-assets'
import type { Asset, DownloadOption, User, Folder, FolderTreeNode } from '@/types'

function isCoarsePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
}

type ItemKind = 'asset' | 'folder'

/** One key space for folders and assets, whose ids could otherwise collide. */
function itemKey(kind: ItemKind, id: string): string {
  return `${kind}:${id}`
}

const assetTypeIcons: Record<string, React.ElementType> = {
  video: Film,
  audio: Music,
  image: ImageIcon,
  image_carousel: Images,
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
  /** Create Share Link in a folder's menu. Absent = not offered. */
  onFolderShare?: (folderId: string, folderName: string) => void
  /** New Subfolder in a folder's menu, with that folder as the parent. */
  onFolderNewSubfolder?: (parentId: string) => void
  onDropToFolder?: (targetFolderId: string, assetIds: string[], folderIds: string[]) => void
  /** Files dropped on a folder card upload into it. Absent = uploads not allowed. */
  onDropFilesToFolder?: (targetFolderId: string, files: File[]) => void
  /** See FolderCard: lets the region above shrink its marking to one folder. */
  onFileDragOverFolder?: (folderId: string | null, from?: string) => void
  /** Which folder holds the file-drag marking. See FolderCard. */
  fileDragTarget?: string | null
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
  /** `rendition` is a DownloadOption id; left out, the server picks. */
  onAssetDownload?: (asset: Asset, rendition?: string) => void
  /** With this, Download opens a submenu of what the asset can be downloaded as. */
  loadAssetDownloadOptions?: (asset: Asset) => Promise<DownloadOption[] | null>
  onAssetRename?: (asset: Asset) => void
  onAssetDelete?: (asset: Asset) => void
  /** Actions rendered on the right side of the navigator bar */
  actions?: React.ReactNode
  /** ⌘/Ctrl-A selects everything shown, shift-click selects a range,
   *  ⌘/Ctrl-click adds or removes one item, and Esc clears the selection. */
  selectionShortcuts?: boolean
  /** Esc with `selectionShortcuts`: clear what the page itself has selected
   *  (the asset in the side panel), alongside the grid's own selection. */
  onDeselectAll?: () => void
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
  onFolderNewSubfolder,
  onDropToFolder,
  onDropFilesToFolder,
  onFileDragOverFolder,
  fileDragTarget,
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
  loadAssetDownloadOptions,
  onAssetRename,
  onAssetDelete,
  actions,
  selectionShortcuts = false,
  onDeselectAll,
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

  // Where a shift-click range starts: the last item clicked or toggled, as an
  // `itemKey`, since folders and assets share one range.
  const rangeAnchorRef = React.useRef<string | null>(null)

  const toggleAssetSelect = (assetId: string) => {
    rangeAnchorRef.current = itemKey('asset', assetId)
    setSelectedAssetIds((prev) => {
      const next = new Set(prev)
      if (next.has(assetId)) next.delete(assetId)
      else next.add(assetId)
      return next
    })
  }

  const toggleFolderSelect = (folderId: string) => {
    rangeAnchorRef.current = itemKey('folder', folderId)
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

  // Drop from the selection whatever is no longer here. A bulk delete is
  // confirmed in the page's dialog and only lands when the lists refetch, so
  // without this the bar went on counting items that were gone. Cancelling
  // the delete removes nothing, and the selection stays.
  React.useEffect(() => {
    const assetIds = new Set(assets.map((a) => a.id))
    const folderIds = new Set((folders ?? []).map((f) => f.id))
    const prune = (prev: Set<string>, present: Set<string>) =>
      Array.from(prev).every((id) => present.has(id))
        ? prev
        : new Set(Array.from(prev).filter((id) => present.has(id)))
    setSelectedAssetIds((prev) => prune(prev, assetIds))
    setSelectedFolderIds((prev) => prune(prev, folderIds))
  }, [assets, folders])

  const totalSelected = selectedAssetIds.size + selectedFolderIds.size

  // What the selection bar offers, shared with right-click on a selected item.
  const selectionActions: SelectionActions = {
    onShare: onCreateShareLink
      ? () => {
          onCreateShareLink(Array.from(selectedAssetIds), Array.from(selectedFolderIds))
          clearSelection()
        }
      : undefined,
    onDownload: onBulkDownload
      ? () => onBulkDownload(Array.from(selectedAssetIds), Array.from(selectedFolderIds))
      : undefined,
    onMove: onBulkMove ? () => setMoveDialogOpen(true) : undefined,
    onDelete: onBulkDelete
      ? () => onBulkDelete(Array.from(selectedAssetIds), Array.from(selectedFolderIds))
      : undefined,
  }

  /** Right-click on an item that is one of several selected acts on all of
   *  them; on anything else it is that item's own menu (undefined here). */
  const selectionMenuFor = (kind: ItemKind, id: string): React.ReactNode | undefined => {
    if (shareMode || totalSelected < 2) return undefined
    const isSelected = kind === 'asset' ? selectedAssetIds.has(id) : selectedFolderIds.has(id)
    return isSelected ? <SelectionMenuItems count={totalSelected} {...selectionActions} /> : undefined
  }
  const selectedTotalSize = Array.from(selectedAssetIds).reduce((sum, id) => sum + (fileSizes[id] ?? 0), 0)

  const filtered = React.useMemo(
    () => sortAssets(assets, sortKey, sortDirection),
    [assets, sortKey, sortDirection],
  )

  const showFolders = !flattenFolders && folders && folders.length > 0

  /** Add every folder and asset between the anchor and this item, in the
   *  order shown: folders first, then assets. */
  const selectRange = (kind: ItemKind, id: string) => {
    const keys = [
      ...(showFolders ? folders!.map((f) => itemKey('folder', f.id)) : []),
      ...filtered.map((a) => itemKey('asset', a.id)),
    ]
    const target = itemKey(kind, id)
    const to = keys.indexOf(target)
    const anchor = rangeAnchorRef.current ?? (selectedAssetId ? itemKey('asset', selectedAssetId) : '')
    const from = keys.indexOf(anchor)
    const range = from === -1 ? [target] : keys.slice(Math.min(from, to), Math.max(from, to) + 1)
    const pick = (k: ItemKind) => range.filter((key) => key.startsWith(`${k}:`)).map((key) => key.slice(k.length + 1))
    setSelectedAssetIds((prev) => new Set([...Array.from(prev), ...pick('asset')]))
    setSelectedFolderIds((prev) => new Set([...Array.from(prev), ...pick('folder')]))
  }

  /** Shift- or ⌘/Ctrl-click with `selectionShortcuts`: change the selection
   *  and report true, so the caller skips what a plain click would do. */
  const handleModifierClick = (kind: ItemKind, id: string, e: React.MouseEvent): boolean => {
    // Ctrl as well as ⌘ for Windows and Linux. On a Mac, Ctrl-click opens the
    // context menu and never arrives here as a click.
    if (!selectionShortcuts || !(e.shiftKey || e.metaKey || e.ctrlKey)) return false
    // Not a click on the item itself: the side panel keeps what it shows, a
    // folder stays closed, and the page behind doesn't treat it as a click on
    // empty space.
    e.preventDefault()
    e.stopPropagation()
    if (e.shiftKey) selectRange(kind, id)
    else if (kind === 'asset') toggleAssetSelect(id)
    else toggleFolderSelect(id)
    return true
  }

  const handleAssetClick = (asset: Asset, e: React.MouseEvent) => {
    if (isCoarsePointer()) return onAssetOpen?.(asset)
    if (handleModifierClick('asset', asset.id, e)) return
    rangeAnchorRef.current = itemKey('asset', asset.id)
    onAssetSelect?.(asset, e)
  }

  const handleAssetCheckbox = (assetId: string, e: React.MouseEvent) => {
    if (selectionShortcuts && e.shiftKey) selectRange('asset', assetId)
    else toggleAssetSelect(assetId)
  }

  const handleFolderCheckbox = (folderId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (selectionShortcuts && e.shiftKey) selectRange('folder', folderId)
    else toggleFolderSelect(folderId)
  }

  // Shift-click would otherwise also select the page's text between clicks.
  const suppressShiftTextSelection = (e: React.MouseEvent) => {
    if (selectionShortcuts && e.shiftKey) e.preventDefault()
  }

  const hasSelection = selectedAssetIds.size > 0 || selectedFolderIds.size > 0 || !!selectedAssetId

  React.useEffect(() => {
    if (!selectionShortcuts) return
    function handleKeyDown(e: KeyboardEvent) {
      const isSelectAll =
        (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a'
      const isDeselect = e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
      if (!isSelectAll && !isDeselect) return
      const target = e.target as HTMLElement
      // Leave these keys to text fields (select this text / cancel the edit)
      // and to dialogs and menus, which sit over the grid and close on Esc.
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable ||
        target.closest('[role="dialog"], [role="menu"]')
      ) return
      if (isSelectAll) {
        e.preventDefault()
        setSelectedAssetIds(new Set(filtered.map((a) => a.id)))
        setSelectedFolderIds(new Set(showFolders ? folders!.map((f) => f.id) : []))
        return
      }
      if (!hasSelection) return
      setSelectedAssetIds(new Set())
      setSelectedFolderIds(new Set())
      rangeAnchorRef.current = null
      onDeselectAll?.()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [selectionShortcuts, filtered, folders, showFolders, hasSelection, onDeselectAll])

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
                  onClick={(e) => {
                    if (shareMode) {
                      e.stopPropagation()
                      toggleFolderSelect(folder.id)
                    } else if (!handleModifierClick('folder', folder.id, e)) {
                      rangeAnchorRef.current = itemKey('folder', folder.id)
                    }
                  }}
                  onMouseDown={suppressShiftTextSelection}
                >
                  <button
                    className={cn(
                      'absolute top-2 left-2 z-10 h-5 w-5 rounded border flex items-center justify-center transition-all',
                      isFolderSelected
                        ? 'bg-accent border-accent text-white opacity-100'
                        : 'bg-black/40 border-white/30 text-transparent opacity-0 group-hover/folder:opacity-100',
                    )}
                    onClick={(e) => handleFolderCheckbox(folder.id, e)}
                  >
                    {isFolderSelected && <Check className="h-3 w-3" />}
                  </button>
                  <FolderCard
                    folder={folder}
                    onOpen={shareMode ? () => {} : onFolderOpen!}
                    onRename={shareMode ? undefined : onFolderRename}
                    onDelete={shareMode ? undefined : onFolderDelete}
                    onShare={shareMode ? undefined : onFolderShare}
                    onNewSubfolder={shareMode ? undefined : onFolderNewSubfolder}
                    contextMenu={selectionMenuFor('folder', folder.id)}
                    onDropItems={shareMode ? undefined : onDropToFolder}
                    onDropFiles={shareMode ? undefined : onDropFilesToFolder}
                    onFileDragOverFolder={shareMode ? undefined : onFileDragOverFolder}
                    fileDragActive={!shareMode && fileDragTarget === folder.id}
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
              onClick={(e) => handleAssetClick(asset, e)}
              onMouseDown={suppressShiftTextSelection}
              onDoubleClick={() => onAssetOpen?.(asset)}
            >
              <AssetCard
                asset={asset}
                projectId={projectId}
                versionCount={versionCounts[asset.id]}
                commentCount={asset.comment_count}
                assignee={asset.assignee_id ? assignees[asset.assignee_id] : null}
                authorName={authorNames[asset.created_by]}
                thumbnailUrl={thumbnails[asset.id]}
                fileSize={fileSizes[asset.id] ?? null}
                selected={selectedAssetIds.has(asset.id)}
                onSelect={(e) => handleAssetCheckbox(asset.id, e)}
                showInfo={showCardInfo}
                showFileSize={showFileSize}
                showUploader={showUploader}
                titleLines={titleLines}
                aspectRatio={aspectRatio}
                thumbnailScale={thumbnailScale}
                onShare={onAssetShare ? () => onAssetShare(asset) : undefined}
                onDownload={onAssetDownload ? (rendition) => onAssetDownload(asset, rendition) : undefined}
                loadDownloadOptions={loadAssetDownloadOptions ? () => loadAssetDownloadOptions(asset) : undefined}
                onRename={onAssetRename ? () => onAssetRename(asset) : undefined}
                onDelete={onAssetDelete ? () => onAssetDelete(asset) : undefined}
                contextMenu={selectionMenuFor('asset', asset.id)}
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
              <WithFolderMenu
                key={folder.id}
                folder={folder}
                actions={{
                  onShare: onFolderShare,
                  onNewSubfolder: onFolderNewSubfolder,
                  onRename: onFolderRename,
                  onDelete: onFolderDelete,
                }}
              >
                {(folderMenu) => (
              <ContextMenuArea items={selectionMenuFor('folder', folder.id) ?? folderMenu}>
              <div
                className={cn(
                  'group flex items-center gap-4 px-3 py-2.5 transition-colors hover:bg-bg-hover cursor-pointer',
                  i !== folders!.length - 1 || filtered.length > 0 ? 'border-b border-border' : '',
                  isFolderSelected && 'bg-accent/5',
                )}
                onClick={(e) => {
                  if (handleModifierClick('folder', folder.id, e)) return
                  rangeAnchorRef.current = itemKey('folder', folder.id)
                  onFolderOpen?.(folder)
                }}
                onMouseDown={suppressShiftTextSelection}
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
                    onClick={(e) => handleFolderCheckbox(folder.id, e)}
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

                {/* Menu */}
                <div className="w-8 shrink-0 flex justify-center opacity-0 group-hover:opacity-100 has-[[data-state=open]]:opacity-100 transition-opacity">
                  {folderMenu && (
                    <DotsMenu items={folderMenu}>
                      <button
                        aria-label={`${folder.name} menu`}
                        onClick={(e) => e.stopPropagation()}
                        className="flex h-6 w-6 items-center justify-center rounded hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors outline-none"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DotsMenu>
                  )}
                </div>
              </div>
              </ContextMenuArea>
                )}
              </WithFolderMenu>
            )
          })}
          {filtered.map((asset, i) => {
            const thumb = thumbnails[asset.id]
            const assignee = asset.assignee_id ? assignees[asset.assignee_id] : null
            const fileSize = fileSizes[asset.id]
            const versionCount = versionCounts[asset.id]
            const author = authorNames[asset.created_by]
            const TypeIcon = assetTypeIcons[asset.asset_type] ?? ImageIcon
            const assetMenu = (
              <AssetMenuItems
                asset={asset}
                onShare={onAssetShare ? () => onAssetShare(asset) : undefined}
                onDownload={onAssetDownload ? (rendition) => onAssetDownload(asset, rendition) : undefined}
                loadDownloadOptions={loadAssetDownloadOptions ? () => loadAssetDownloadOptions(asset) : undefined}
                onRename={onAssetRename ? () => onAssetRename(asset) : undefined}
                onDelete={onAssetDelete ? () => onAssetDelete(asset) : undefined}
              />
            )
            return (
              <ContextMenuArea key={asset.id} items={selectionMenuFor('asset', asset.id) ?? assetMenu}>
              <div
                onClick={(e) => handleAssetClick(asset, e)}
                onMouseDown={suppressShiftTextSelection}
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
                    onClick={(e) => { e.stopPropagation(); handleAssetCheckbox(asset.id, e) }}
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
                  {assignee && <Avatar src={assignee.avatar_url} name={assignee.name} color={assignee.avatar_color} size="sm" />}
                </div>
                {/* Menu — hidden until hover */}
                <div className="w-8 shrink-0 flex justify-center opacity-0 group-hover:opacity-100 has-[[data-state=open]]:opacity-100 transition-opacity">
                  <DotsMenu items={assetMenu}>
                    <button
                      aria-label={`${asset.name} menu`}
                      onClick={(e) => e.stopPropagation()}
                      className="flex h-6 w-6 items-center justify-center rounded hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors outline-none"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </DotsMenu>
                </div>
              </div>
              </ContextMenuArea>
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
          {selectionActions.onDelete && (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={selectionActions.onDelete}>
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          )}
          {selectionActions.onMove && (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={selectionActions.onMove}>
              <FolderInput className="h-4 w-4" /> Move to
            </Button>
          )}
          {selectionActions.onShare && (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={selectionActions.onShare}>
              <Share2 className="h-4 w-4" /> Share
            </Button>
          )}
          {selectionActions.onDownload && (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={selectionActions.onDownload}>
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
