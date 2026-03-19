'use client'

import * as React from 'react'
import { Film, Music, Image as ImageIcon, Images, GitBranch, AlertCircle, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/shared/badge'
import { Avatar } from '@/components/shared/avatar'
import type { Asset, AssetType, User } from '@/types'

const assetTypeIcons: Record<AssetType, React.ElementType> = {
  video: Film,
  audio: Music,
  image: ImageIcon,
  image_carousel: Images,
}

const assetTypeLabels: Record<AssetType, string> = {
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
  image_carousel: 'Carousel',
}

interface AssetCardProps {
  asset: Asset
  projectId: string
  versionCount?: number
  assignee?: User | null
  thumbnailUrl?: string | null
  className?: string
}

function getDueDateState(dueDate: string | null): 'overdue' | 'soon' | 'normal' | null {
  if (!dueDate) return null
  const due = new Date(dueDate).getTime()
  const now = Date.now()
  const diffDays = (due - now) / (1000 * 60 * 60 * 24)
  if (diffDays < 0) return 'overdue'
  if (diffDays <= 3) return 'soon'
  return 'normal'
}

export function AssetCard({
  asset,
  projectId,
  versionCount = 1,
  assignee,
  thumbnailUrl,
  className,
}: AssetCardProps) {
  const TypeIcon = assetTypeIcons[asset.asset_type]
  const dueDateState = getDueDateState(asset.due_date)

  return (
    <div
      className={cn(
        'group flex flex-col gap-2 rounded-xl border border-border bg-bg-secondary w-full',
        'hover:border-border-focus hover:bg-bg-tertiary transition-all duration-200 hover:shadow-lg hover:shadow-black/10 overflow-hidden',
        className,
      )}
    >
      {/* Thumbnail */}
      <div className="relative aspect-video w-full bg-bg-tertiary overflow-hidden flex items-center justify-center group-hover:brightness-110 transition-all duration-200">
        {thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl}
            alt={asset.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <TypeIcon className="h-8 w-8 text-text-tertiary" />
        )}
        {/* Asset type pill */}
        <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium bg-bg-primary/80 text-text-secondary backdrop-blur-sm">
          <TypeIcon className="h-3 w-3" />
          {assetTypeLabels[asset.asset_type]}
        </span>
      </div>

      {/* Info */}
      <div className="flex flex-col gap-1.5 p-3 pt-0">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-text-primary line-clamp-1 group-hover:text-accent transition-colors">
            {asset.name}
          </p>
          <Badge status={asset.status} />
        </div>

        {/* Version count + assignee row */}
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-2xs text-text-tertiary">
            <GitBranch className="h-3 w-3" />
            v{versionCount}
          </span>

          {assignee && (
            <Avatar src={assignee.avatar_url} name={assignee.name} size="sm" />
          )}
        </div>

        {/* Due date */}
        {dueDateState && (
          <div
            className={cn(
              'mt-1 flex items-center gap-1 text-2xs font-medium',
              dueDateState === 'overdue' ? 'text-status-error' : 'text-status-warning',
            )}
          >
            {dueDateState === 'overdue' ? (
              <AlertCircle className="h-3 w-3" />
            ) : (
              <Clock className="h-3 w-3" />
            )}
            {dueDateState === 'overdue' ? 'Overdue' : 'Due soon'}
          </div>
        )}
        {asset.due_date && dueDateState === 'normal' && (
          <div className="flex items-center gap-1 text-2xs text-text-tertiary">
            <Clock className="h-3 w-3" />
            Due {new Date(asset.due_date).toLocaleDateString()}
          </div>
        )}
      </div>
    </div>
  )
}
