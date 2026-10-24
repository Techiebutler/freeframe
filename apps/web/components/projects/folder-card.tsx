'use client'

import React, { useCallback, useRef, useState } from 'react'
import useSWR from 'swr'
import { Folder, Film, Music, Image as ImageIcon, Images, MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { ContextMenuArea, DotsMenu } from '@/components/shared/item-menu'
import { useFolderMenu } from './menus/folder-menu'
import type { Folder as FolderType, AssetResponse } from '@/types'
import { carriesFiles } from '@/lib/drag'
import { collectDataTransfer, type Collected } from '@/lib/upload-folder-walk'

const assetTypeIcons = {
  video: Film,
  audio: Music,
  image: ImageIcon,
  image_carousel: Images,
} as const

function ThumbCell({ asset, className }: { asset: AssetResponse; className?: string }) {
  const [failed, setFailed] = React.useState(false)
  const TypeIcon = assetTypeIcons[asset.asset_type as keyof typeof assetTypeIcons] ?? ImageIcon

  if (failed || !asset.thumbnail_url) {
    return (
      <div className={cn('overflow-hidden bg-bg-tertiary flex items-center justify-center', className)}>
        <TypeIcon className="h-6 w-6 text-text-tertiary/50" />
      </div>
    )
  }

  return (
    <div className={cn('overflow-hidden bg-bg-tertiary', className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={asset.thumbnail_url}
        alt={asset.name}
        onError={() => setFailed(true)}
        className="h-full w-full object-cover"
      />
    </div>
  )
}

function FolderThumbnails({ projectId, folderId, itemCount }: { projectId: string; folderId: string; itemCount: number }) {
  const { data: assets } = useSWR<AssetResponse[]>(
    itemCount > 0 ? `/projects/${projectId}/assets?folder_id=${folderId}` : null,
    (key: string) => api.get<AssetResponse[]>(key),
    { revalidateOnFocus: false },
  )

  // Prefer assets with thumbnails first, fill with any up to 3
  const sorted = (assets ?? []).sort((a, b) => (b.thumbnail_url ? 1 : 0) - (a.thumbnail_url ? 1 : 0))
  const thumbs = sorted.slice(0, 3)

  if (thumbs.length === 0) {
    return (
      <div className="aspect-[4/3] flex items-center justify-center bg-bg-tertiary rounded-t-lg">
        <Folder className="h-12 w-12 text-text-tertiary/50" />
      </div>
    )
  }

  return (
    <div className={cn(
      'aspect-[4/3] rounded-t-lg overflow-hidden grid gap-px bg-bg-tertiary',
      thumbs.length === 1 && 'grid-cols-1',
      thumbs.length >= 2 && 'grid-cols-2',
    )}>
      {thumbs.map((asset, i) => (
        <ThumbCell
          key={asset.id}
          asset={asset}
          className={thumbs.length === 3 && i === 0 ? 'row-span-2' : undefined}
        />
      ))}
    </div>
  )
}

interface FolderCardProps {
  folder: FolderType
  selected?: boolean
  onOpen: (folder: FolderType) => void
  onSelect?: (e: React.MouseEvent) => void
  onRename?: (folderId: string, name: string) => Promise<void>
  onDelete?: (folderId: string) => Promise<void>
  onShare?: (folderId: string, folderName: string) => void
  /** New Subfolder in the menu, with this folder as the parent. */
  onNewSubfolder?: (parentId: string) => void
  /** Shown on right-click instead of the folder's own menu: the grid passes the
   *  selection's menu when this folder is one of several selected. */
  contextMenu?: React.ReactNode
  onDropItems?: (targetFolderId: string, assetIds: string[], folderIds: string[]) => void
  /** Files dropped on this folder upload into it, as `collectDataTransfer`
   *  reads them. Absent = uploads not allowed here. */
  onDropFiles?: (targetFolderId: string, dropped: Promise<Collected>) => void
  /** Tells the region above that a file drag is over this folder, so it can
   *  shrink its own marking to this one -- two frames lit at once do not say
   *  where the file will land. On release the folder names itself, so a leave
   *  arriving after the next folder has claimed the drag cannot end its turn. */
  onFileDragOverFolder?: (folderId: string | null, from?: string) => void
  /** Whether this folder is the current file-drag target. Owned by the region
   *  rather than by the card: only one folder can hold it, so "exactly one
   *  frame is lit" is a property of the state and not of the cards agreeing. */
  fileDragActive?: boolean
  className?: string
}

export function FolderCard({
  folder,
  selected,
  onOpen,
  onSelect,
  onRename,
  onDelete,
  onShare,
  onNewSubfolder,
  contextMenu,
  onDropItems,
  onDropFiles,
  onFileDragOverFolder,
  fileDragActive,
  className,
}: FolderCardProps) {
  const [isDragOver, setIsDragOver] = useState(false)
  const { items: menuItems, dialogs: menuDialogs } = useFolderMenu(folder, {
    onShare,
    onNewSubfolder,
    onRename,
    onDelete,
  })

  // Draggable
  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData(
        'application/json',
        JSON.stringify({ folderIds: [folder.id], assetIds: [] }),
      )
      e.dataTransfer.effectAllowed = 'move'
    },
    [folder.id],
  )

  // Counted, not toggled: dragenter/dragleave fire for the card's own children
  // too, so a boolean drops the highlight as the pointer crosses the thumbnail.
  const dragDepth = useRef(0)

  const clearDrag = useCallback(() => {
    dragDepth.current = 0
    setIsDragOver(false)
    onFileDragOverFolder?.(null, folder.id)
  }, [folder.id, onFileDragOverFolder])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!carriesFiles(e) || !onDropFiles) return
    e.preventDefault()
    // Deliberately NOT stopPropagation: the region above counts dragenter
    // against dragleave to know when the pointer has left it entirely, and
    // swallowing one half of that pair makes its counter drift.
    dragDepth.current += 1
    // No local highlight for a file drag: `fileDragActive` decides that, so two
    // cards cannot both be lit while the pointer is between them.
    onFileDragOverFolder?.(folder.id)
  }, [folder.id, onDropFiles, onFileDragOverFolder])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (carriesFiles(e) && onDropFiles) {
      // See handleDragEnter: this half bubbles too, or the region's count of
      // its own children never comes back down.
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current > 0) return
    }
    clearDrag()
  }, [clearDrag, onDropFiles])

  // Drop target
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (carriesFiles(e)) {
      // Prevented before anything else. A reviewer, correctly given no upload
      // handler, used to fall through to the browser's own file handling,
      // which navigates the tab to `file:///...` and takes the app with it.
      // Refusing has to be explicit; `none` is what says so to the pointer.
      e.preventDefault()
      if (!onDropFiles) {
        e.dataTransfer.dropEffect = 'none'
        return
      }
      // A folder is a more specific target than the region behind it, so it
      // takes the event rather than letting it through.
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      // Re-asserted on every dragover, not only on entry: this is what makes
      // the marking recover by itself if anything ever releases it early.
      onFileDragOverFolder?.(folder.id)
      return
    }
    e.preventDefault()
    // Taken here, as a file drop is: a card dragged by its thumbnail also lists
    // `Files` in Chrome and Safari, and the shell's refusal behind this would
    // set `none` over the move.
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setIsDragOver(true)
  }, [folder.id, onDropFiles, onFileDragOverFolder])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (carriesFiles(e)) {
        // See handleDragOver: prevented whether or not it is accepted.
        e.preventDefault()
        if (!onDropFiles) return
        // Stops the region above uploading the same files into the open folder.
        e.stopPropagation()
        clearDrag()
        // Read here, in the drop event's own turn: afterwards the drop's items
        // answer nothing, and a dropped folder is only an unreadable
        // placeholder in `files`. Handed over even when the drop is empty,
        // which is what several promised-file sources on macOS produce. The
        // region behind this card never sees the drop, so its marking comes
        // down through this call and nothing else: skipping it leaves "Drop to
        // upload" on screen for good.
        onDropFiles(folder.id, collectDataTransfer(e.dataTransfer))
        return
      }
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)
      try {
        const data = JSON.parse(e.dataTransfer.getData('application/json'))
        // Don't allow dropping a folder onto itself
        if (data.folderIds?.includes(folder.id)) return
        onDropItems?.(folder.id, data.assetIds ?? [], data.folderIds ?? [])
      } catch {}
    },
    [folder.id, onDropItems, onDropFiles, clearDrag],
  )

  return (
    <>
      <ContextMenuArea items={contextMenu ?? menuItems}>
      <div
        className={cn(
          'group relative rounded-lg border bg-bg-tertiary/50 cursor-pointer transition-all hover:border-border-focus hover:scale-[1.01]',
          selected ? 'ring-2 ring-accent border-accent/50' : 'border-border',
          (isDragOver || fileDragActive) && 'ring-2 ring-accent/50 bg-accent/5',
          className,
        )}
        draggable
        onDragStart={handleDragStart}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onDoubleClick={() => onOpen(folder)}
        onClick={onSelect}
      >
        {/* Folder thumbnail preview */}
        <FolderThumbnails projectId={folder.project_id} folderId={folder.id} itemCount={folder.item_count} />

        {/* Info */}
        <div className="px-3 py-2">
          <div className="flex items-start justify-between gap-1">
            <p className="text-sm font-medium text-text-primary truncate">{folder.name}</p>
            {menuItems && (
              <DotsMenu items={menuItems}>
                <button
                  aria-label={`${folder.name} menu`}
                  className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 flex items-center justify-center h-6 w-6 rounded hover:bg-bg-hover transition-opacity shrink-0"
                  // Opening the menu is not a click on the folder.
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="h-3.5 w-3.5 text-text-tertiary" />
                </button>
              </DotsMenu>
            )}
          </div>
          <p className="text-xs text-text-tertiary mt-0.5">
            {folder.item_count} {folder.item_count === 1 ? 'Item' : 'Items'}
          </p>
        </div>
      </div>
      </ContextMenuArea>

      {menuDialogs}
    </>
  )
}
