'use client'

import * as React from 'react'
import { Film, Music, Image as ImageIcon, Images, MoreHorizontal, Check } from 'lucide-react'
import { cn, formatRelativeTime, formatBytes } from '@/lib/utils'
import type { Asset, AssetType, DownloadOption, User } from '@/types'
import { ContextMenuArea, DotsMenu } from '@/components/shared/item-menu'
import { CommentCountBadge } from '@/components/shared/comment-count-badge'
import { AssetMenuItems } from './menus/asset-menu'
import type { AspectRatio, ThumbnailScale, TitleLines } from '@/stores/view-store'

const assetTypeIcons: Record<AssetType, React.ElementType> = {
  video: Film,
  audio: Music,
  image: ImageIcon,
  image_carousel: Images,
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
  /** `rendition` is a DownloadOption id; left out, the server picks. */
  onDownload?: (rendition?: string) => void
  /** With this, Download opens a submenu of what the asset can be downloaded as. */
  loadDownloadOptions?: () => Promise<DownloadOption[] | null>
  onRename?: () => void
  onDelete?: () => void
  /** Shown on right-click instead of the asset's own menu: the grid passes the
   *  selection's menu when this asset is one of several selected. */
  contextMenu?: React.ReactNode
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
  loadDownloadOptions,
  onRename,
  onDelete,
  contextMenu,
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

  const menuItems = (
    <AssetMenuItems
      asset={asset}
      onShare={onShare}
      onDownload={onDownload}
      loadDownloadOptions={loadDownloadOptions}
      onRename={onRename}
      onDelete={onDelete}
    />
  )

  return (
    // Right-click works with or without the info row, which is where ⋯ lives.
    <ContextMenuArea items={contextMenu ?? menuItems}>
    <div
      draggable
      onDragStart={onDragStart}
      className={cn(
        'group flex flex-col rounded-lg overflow-hidden transition-all duration-150 cursor-pointer',
        'border-2',
        selected
          ? 'border-accent bg-accent/5 shadow-lg shadow-accent/10'
          : 'border-transparent [@media(hover:hover)]:hover:border-border-focus',
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
              'h-full w-full transition-transform duration-200 [@media(hover:hover)]:group-hover:scale-[1.02]',
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
                : 'bg-black/40 text-white/60 [@media(hover:hover)]:text-transparent [@media(hover:hover)]:group-hover:text-white/60 backdrop-blur-sm',
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

        {/* Comment count badge — bottom-left, as in a share link's grid */}
        <CommentCountBadge count={commentCount} />
      </div>

      {/* Info section */}
      {showInfo && (
        <div className="flex flex-col gap-1 px-2 pt-2 pb-1.5">
          {/* Title + context menu */}
          <div className="flex items-start justify-between gap-1">
            <p className={cn('text-sm font-medium text-text-primary leading-tight', lineClamp)}>
              {asset.name}
            </p>
            <DotsMenu items={menuItems}>
              <button
                aria-label={`${asset.name} menu`}
                onClick={(e) => e.stopPropagation()}
                className="shrink-0 h-5 w-5 flex items-center justify-center rounded text-text-tertiary opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 data-[state=open]:opacity-100 [@media(hover:hover)]:hover:bg-bg-hover [@media(hover:hover)]:hover:text-text-primary transition-all outline-none"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DotsMenu>
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
    </ContextMenuArea>
  )
}
