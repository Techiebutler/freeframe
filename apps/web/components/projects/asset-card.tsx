'use client'

import * as React from 'react'
import { Film, Music, Image as ImageIcon, Images, MessageSquare, MoreHorizontal, Check, Clock } from 'lucide-react'
import { cn, formatRelativeTime } from '@/lib/utils'
import { Badge } from '@/components/shared/badge'
import type { Asset, AssetType, User } from '@/types'

const assetTypeIcons: Record<AssetType, React.ElementType> = {
  video: Film,
  audio: Music,
  image: ImageIcon,
  image_carousel: Images,
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
  onContextMenu?: (e: React.MouseEvent) => void
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
  onContextMenu,
  className,
}: AssetCardProps) {
  const TypeIcon = assetTypeIcons[asset.asset_type]

  return (
    <div
      className={cn(
        'group flex flex-col rounded-lg overflow-hidden transition-all duration-150 cursor-pointer',
        'border-2',
        selected
          ? 'border-accent bg-accent/5 shadow-lg shadow-accent/10'
          : 'border-transparent hover:border-border-focus',
        className,
      )}
    >
      {/* Thumbnail area — taller like Frame.io */}
      <div className="relative aspect-[4/3] w-full bg-bg-tertiary overflow-hidden flex items-center justify-center">
        {thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl}
            alt={asset.name}
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
          />
        ) : (
          <TypeIcon className="h-12 w-12 text-text-tertiary/50" />
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
      <div className="flex flex-col gap-1 px-2 pt-2 pb-1.5">
        {/* Title + context menu */}
        <div className="flex items-start justify-between gap-1">
          <p className="text-sm font-medium text-text-primary line-clamp-1 leading-tight">
            {asset.name}
          </p>
          <button
            onClick={(e) => { e.stopPropagation(); onContextMenu?.(e) }}
            className="shrink-0 h-5 w-5 flex items-center justify-center rounded text-text-tertiary opacity-0 group-hover:opacity-100 hover:bg-bg-hover hover:text-text-primary transition-all"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Author + date row */}
        <p className="text-2xs text-text-tertiary line-clamp-1">
          {authorName && <span>{authorName} &bull; </span>}
          {formatRelativeTime(asset.created_at)}
        </p>
      </div>

      {/* Status field — bottom of card like Frame.io */}
      <div className="px-2 pb-2 mt-auto">
        <div className="flex items-center gap-1.5 rounded border border-border bg-bg-tertiary/50 px-2 py-1">
          <Badge status={asset.status} />
        </div>
      </div>
    </div>
  )
}
