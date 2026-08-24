'use client'

import * as React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Film, Music, Image as ImageIcon, Images, FileText, MessageSquare, MoreHorizontal, Check, Share2, Download, Link as LinkIcon, Pencil, Trash2 } from 'lucide-react'
import { cn, formatRelativeTime, formatBytes } from '@/lib/utils'
import type { Asset, AssetType, User } from '@/types'
import type { AspectRatio, ThumbnailScale, TitleLines } from '@/stores/view-store'

const assetTypeIcons: Record<AssetType, React.ElementType> = {
  video: Film,
  audio: Music,
  image: ImageIcon,
  image_carousel: Images,
  document: FileText,
}

const aspectMap = {
  landscape: 'aspect-[16/10]',
  square: 'aspect-square',
  portrait: 'aspect-[3/4]',
}

interface AssetCardProps {
  asset: Asset
  projectId: string
  versionCount?: number
  assignee?: User | null
  authorName?: string
  thumbnailUrl?: string | null
  commentCount?: number
  duration?: number | null
  selected?: boolean
  onSelect?: (e: React.MouseEvent) => void
  onDragStart?: (e: React.DragEvent) => void
  onShare?: () => void
  onDownload?: () => void
  onRename?: () => void
  onDelete?: () => void
  fileSize?: number | null
  // Appearance settings
  showInfo?: boolean
  showFileSize?: boolean
  showUploader?: boolean
  titleLines?: TitleLines
  aspectRatio?: AspectRatio
  thumbnailScale?: ThumbnailScale
  className?: string
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  if (m >= 60) {
    const h = Math.floor(m / 60)
    const rm = m % 60
    return `${h}:${String(rm).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function AssetCard({
  asset,
  projectId,
  versionCount = 1,
  assignee,
  authorName,
  thumbnailUrl,
  commentCount,
  duration,
  selected = false,
  onSelect,
  onDragStart,
  onShare,
  onDownload,
  onRename,
  onDelete,
  fileSize,
  showInfo = true,
  showFileSize = true,
  showUploader = true,
  titleLines = '1',
  aspectRatio = 'landscape',
  thumbnailScale = 'fit',
  className,
}: AssetCardProps) {
  const TypeIcon = assetTypeIcons[asset.asset_type]
  const lineClamp = titleLines === '1' ? 'line-clamp-1' : titleLines === '2' ? 'line-clamp-2' : 'line-clamp-3'
  const [imgError, setImgError] = React.useState(false)

  return (
    <div
      draggable
      onDragStart={onDragStart}
      className={cn(
        'group flex flex-col rounded-lg overflow-hidden transition-all duration-150 cursor-pointer',
        'border-2',
        selected
          ? 'border-accent bg-accent/5 shadow-lg shadow-accent/10'
          : 'border-transparent hover:border-border-focus',
        className,
      )}
    >
      {/* Thumbnail area */}
      <div className={cn(
        'relative w-full bg-bg-tertiary overflow-hidden flex items-center justify-center',
        aspectMap[aspectRatio],
      )}>
        {thumbnailUrl && !imgError ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl}
            alt={asset.name}
            onError={() => setImgError(true)}
            className={cn(
              'h-full w-full transition-transform duration-200 group-hover:scale-[1.02]',
              thumbnailScale === 'fill' ? 'object-cover' : 'object-contain',
            )}
          />
        ) : (
          <div className="flex items-center justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-hover text-text-secondary">
              <TypeIcon className="h-7 w-7" />
            </div>
          </div>
        )}

        {/* Selection checkbox — top-left */}
        {onSelect && (
          <button
            onClick={(e) => { e.stopPropagation(); onSelect(e) }}
            className={cn(
              'absolute top-2 left-2 h-5 w-5 rounded flex items-center justify-center transition-all',
              selected
                ? 'bg-accent text-white'
                : 'bg-black/40 text-transparent group-hover:text-white/60 backdrop-blur-sm',
            )}
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        )}

        {/* Duration badge — bottom-right (for video/audio) */}
        {duration != null && duration > 0 && (
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-2xs font-medium text-white tabular-nums backdrop-blur-sm">
            {formatDuration(duration)}
          </span>
        )}

        {/* Comment count badge — bottom-left */}
        {commentCount != null && commentCount > 0 && (
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-2xs font-medium text-white backdrop-blur-sm">
            <MessageSquare className="h-3 w-3" />
            {commentCount}
          </span>
        )}
      </div>

      {/* Info section */}
      {showInfo && (
        <div className="flex flex-col gap-1 px-2 pt-2 pb-1.5">
          {/* Title + context menu */}
          <div className="flex items-start justify-between gap-1">
            <p className={cn('text-sm font-medium text-text-primary leading-tight', lineClamp)}>
              {asset.name}
            </p>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  onClick={(e) => e.stopPropagation()}
                  className="shrink-0 h-5 w-5 flex items-center justify-center rounded text-text-tertiary opacity-0 group-hover:opacity-100 hover:bg-bg-hover hover:text-text-primary transition-all outline-none"
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
                    onSelect={onShare}
                    className="flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                  >
                    <Share2 className="h-3.5 w-3.5 text-text-tertiary" />
                    Create Share Link
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="my-1 h-px bg-border mx-1" />
                  <DropdownMenu.Item
                    onSelect={onDownload}
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
                    onSelect={onRename}
                    className="flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                  >
                    <Pencil className="h-3.5 w-3.5 text-text-tertiary" />
                    Rename
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={onDelete}
                    className="flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-status-error hover:bg-status-error/10 cursor-pointer outline-none transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>

          {/* Author + date + file size row */}
          <p className="text-2xs text-text-tertiary line-clamp-1">
            {showUploader && authorName && <span>{authorName} &bull; </span>}
            {formatRelativeTime(asset.created_at)}
            {showFileSize && fileSize ? <span> &bull; {formatBytes(fileSize)}</span> : null}
          </p>
        </div>
      )}
    </div>
  )
}
