'use client'

import * as React from 'react'
import useSWR from 'swr'
import Link from 'next/link'
import { FolderOpen, Clock, UserCheck, type LucideIcon } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { formatRelativeTime } from '@/lib/utils'
import { EmptyState } from '@/components/shared/empty-state'
import { Badge } from '@/components/shared/badge'
import type { Asset } from '@/types'

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

interface AssetCardProps {
  asset: Asset
}

function AssetCard({ asset }: AssetCardProps) {
  return (
    <Link
      href={`/assets/${asset.id}`}
      className="group flex flex-col gap-2 rounded-lg border border-border bg-bg-secondary p-3 hover:border-border-focus hover:bg-bg-tertiary transition-colors"
    >
      {/* Thumbnail placeholder */}
      <div className="aspect-video w-full rounded-md bg-bg-tertiary overflow-hidden flex items-center justify-center text-text-tertiary">
        <FolderOpen className="h-6 w-6" />
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-text-primary line-clamp-1 group-hover:text-accent transition-colors">
            {asset.name}
          </p>
          <Badge status={asset.status} />
        </div>
        <p className="text-xs text-text-tertiary">
          {formatRelativeTime(asset.updated_at)}
        </p>
        {asset.due_date && (
          <p className="text-xs text-status-warning">
            Due {new Date(asset.due_date).toLocaleDateString()}
          </p>
        )}
      </div>
    </Link>
  )
}

interface SectionProps {
  title: string
  icon: LucideIcon
  assets: Asset[] | undefined
  isLoading: boolean
  emptyTitle: string
  emptyDescription: string
}

function Section({
  title,
  icon: Icon,
  assets,
  isLoading,
  emptyTitle,
  emptyDescription,
}: SectionProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-text-secondary" />
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        {assets && assets.length > 0 && (
          <span className="text-xs text-text-tertiary">({assets.length})</span>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="aspect-video animate-pulse rounded-lg bg-bg-tertiary"
            />
          ))}
        </div>
      ) : !assets || assets.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg-secondary">
          <EmptyState
            icon={Icon}
            title={emptyTitle}
            description={emptyDescription}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {assets.slice(0, 8).map((asset) => (
            <AssetCard key={asset.id} asset={asset} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function HomePage() {
  const { user } = useAuthStore()

  const { data: recentAssets, isLoading: loadingRecent } = useSWR(
    '/me/assets?filter=owned',
    () => api.get<Asset[]>('/me/assets?filter=owned'),
  )

  const { data: assignedAssets, isLoading: loadingAssigned } = useSWR(
    '/me/assets?filter=assigned',
    () => api.get<Asset[]>('/me/assets?filter=assigned'),
  )

  const { data: dueSoonAssets, isLoading: loadingDueSoon } = useSWR(
    '/me/assets?filter=due_soon',
    () => api.get<Asset[]>('/me/assets?filter=due_soon'),
  )

  return (
    <div className="p-6 space-y-8 max-w-7xl">
      {/* Greeting */}
      <div>
        <h1 className="text-xl font-semibold text-text-primary">
          {getGreeting()},{' '}
          <span className="text-accent">{user?.name?.split(' ')[0] ?? 'there'}</span>
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          Here&apos;s what&apos;s happening with your assets today.
        </p>
      </div>

      {/* Sections */}
      <Section
        title="Recent"
        icon={Clock}
        assets={recentAssets}
        isLoading={loadingRecent}
        emptyTitle="No assets yet"
        emptyDescription="Assets you create or own will appear here."
      />

      <Section
        title="Assigned to me"
        icon={UserCheck}
        assets={assignedAssets}
        isLoading={loadingAssigned}
        emptyTitle="Nothing assigned"
        emptyDescription="Assets assigned to you for review will appear here."
      />

      <Section
        title="Due soon"
        icon={Clock}
        assets={dueSoonAssets}
        isLoading={loadingDueSoon}
        emptyTitle="No upcoming deadlines"
        emptyDescription="Assets due within the next 7 days will appear here."
      />
    </div>
  )
}
