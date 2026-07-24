'use client'

import React, { useCallback, useState } from 'react'
import useSWR from 'swr'
import { Folder, Film, Music, Image as ImageIcon, Images, MoreHorizontal, Pencil, Trash, Share2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { NameDialog } from './name-dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { Folder as FolderType, AssetResponse } from '@/types'

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
      <div className="ff-dotgrid aspect-[4/3] flex items-center justify-center bg-bg-tertiary rounded-t-lg">
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
  onShare?: (folderId: string, folderName: string) => Promise<void>
  onDropItems?: (targetFolderId: string, assetIds: string[], folderIds: string[]) => void
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
  onDropItems,
  className,
}: FolderCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const menuRef = React.useRef<HTMLDivElement>(null)

  // Close menu on outside click
  React.useEffect(() => {
    if (!menuOpen) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menuOpen])

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

  // Drop target
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setIsDragOver(true)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      try {
        const data = JSON.parse(e.dataTransfer.getData('application/json'))
        // Don't allow dropping a folder onto itself
        if (data.folderIds?.includes(folder.id)) return
        onDropItems?.(folder.id, data.assetIds ?? [], data.folderIds ?? [])
      } catch {}
    },
    [folder.id, onDropItems],
  )

  return (
    <>
      <div
        className={cn(
          'group relative rounded-lg border bg-bg-secondary cursor-pointer transition-colors hover:border-border-strong',
          selected ? 'ring-2 ring-accent border-accent/50' : 'border-border',
          isDragOver && 'ring-2 ring-accent/50 bg-accent/5',
          menuOpen && 'z-[60]',
          className,
        )}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={() => setIsDragOver(false)}
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
            <div className="relative" ref={menuRef}>
              <button
                className="opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 flex items-center justify-center h-6 w-6 rounded hover:bg-bg-hover transition-opacity shrink-0"
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen((p) => !p)
                }}
              >
                <MoreHorizontal className="h-3.5 w-3.5 text-text-tertiary" />
              </button>

              {menuOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 w-40 rounded border border-border bg-bg-elevated shadow-xl py-1">
                  <button
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuOpen(false)
                      setRenameOpen(true)
                    }}
                  >
                    <Pencil className="h-3 w-3" /> Rename
                  </button>
                  <button
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuOpen(false)
                      onShare?.(folder.id, folder.name)
                    }}
                  >
                    <Share2 className="h-3 w-3" /> Share
                  </button>
                  <button
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-accent hover:bg-accent-muted"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuOpen(false)
                      setDeleteOpen(true)
                    }}
                  >
                    <Trash className="h-3 w-3" /> Delete
                  </button>
                </div>
              )}
            </div>
          </div>
          <p className="font-mono text-[10px] text-text-tertiary mt-0.5">
            {folder.item_count} {folder.item_count === 1 ? 'Item' : 'Items'}
          </p>
        </div>
      </div>

      {/* Rename dialog */}
      <NameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Rename Folder"
        placeholder="Folder name"
        defaultValue={folder.name}
        submitLabel="Rename"
        onSubmit={(name) => onRename?.(folder.id, name)}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete "${folder.name}"?`}
        description="This folder and all its contents will be moved to trash. You can restore them later."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => onDelete?.(folder.id)}
      />
    </>
  )
}
