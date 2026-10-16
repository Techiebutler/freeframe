'use client'

import * as React from 'react'
import Link from 'next/link'
import { MoreHorizontal, ImagePlus, Globe, Lock } from 'lucide-react'
import { cn, formatRelativeTime, formatBytes } from '@/lib/utils'
import { getGradientForProject } from '@/lib/gradient-utils'
import { ContextMenuArea, DotsMenu } from '@/components/shared/item-menu'
import { useProjectMenu } from './menus/project-menu'
import type { Project } from '@/types'

interface ProjectCardProps {
  project: Project
  showRole?: boolean
  isOwner?: boolean
  /** Show the info row under the poster. */
  showInfo?: boolean
  className?: string
  onMutate?: () => void
}

export function ProjectCard({
  project,
  showRole,
  isOwner,
  showInfo = true,
  className,
  onMutate,
}: ProjectCardProps) {
  const gradient = getGradientForProject(project.id)
  const assetCount = project.asset_count ?? 0
  const { items: menuItems, dialogs: menuDialogs } = useProjectMenu(project, { isOwner, onMutate })

  return (
    <>
      <ContextMenuArea items={menuItems}>
      <div className={cn('group relative', className)}>
        <Link
          href={`/projects/${project.id}`}
          className="block rounded-xl overflow-hidden bg-bg-secondary border border-border hover:border-accent/40 transition-all duration-200 hover:shadow-lg hover:shadow-black/10"
        >
          {/* Square poster area */}
          <div className="relative aspect-square w-full overflow-hidden">
            {project.poster_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={project.poster_url}
                alt={project.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className={cn('h-full w-full bg-gradient-to-br', gradient)}>
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_40%,rgba(255,255,255,0.1),transparent_60%)]" />
              </div>
            )}

            {/* Bottom gradient overlay for text */}
            <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />

            {/* Project name overlay */}
            <div className="absolute inset-x-0 bottom-0 p-3">
              <p className="text-sm font-semibold text-white line-clamp-2 drop-shadow-sm">
                {project.name}
              </p>
              {project.description && (
                <p className="text-[11px] text-white/70 line-clamp-1 mt-0.5">
                  {project.description}
                </p>
              )}
            </div>

            {/* Public/role badges */}
            <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5">
              {project.is_public && (
                <span className="inline-flex items-center gap-1 rounded-full bg-black/30 backdrop-blur-sm px-2 py-0.5 text-[10px] font-medium text-white/90">
                  <Globe className="h-2.5 w-2.5" />
                  Public
                </span>
              )}
              {showRole && project.role && project.role !== 'owner' && (
                <span className="inline-flex items-center rounded-full bg-black/30 backdrop-blur-sm px-2 py-0.5 text-[10px] font-medium text-white/90 capitalize">
                  {project.role}
                </span>
              )}
            </div>
          </div>

          {/* Footer */}
          {showInfo && (
            <div className="flex items-center justify-between px-3 py-2.5">
              <span className="text-2xs text-text-tertiary">
                {assetCount > 0
                  ? `${assetCount} item${assetCount !== 1 ? 's' : ''} · ${formatBytes(project.storage_bytes ?? 0)}`
                  : `Updated ${formatRelativeTime(project.created_at)}`}
              </span>
            </div>
          )}
        </Link>

        {/* Menu button: owners only, like the menu itself */}
        {menuItems && (
          <DotsMenu items={menuItems}>
            <button
              aria-label={`${project.name} menu`}
              className={cn(
                'absolute flex h-7 w-7 items-center justify-center rounded-md transition-all opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100',
                // Without the info row it sits on the poster, styled like the badges.
                showInfo
                  ? 'bottom-2 right-2.5 text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
                  : 'top-2.5 right-2.5 bg-black/30 backdrop-blur-sm text-white/90 hover:bg-black/50 hover:text-white',
              )}
              onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DotsMenu>
        )}
      </div>
      </ContextMenuArea>

      {menuDialogs}
    </>
  )
}
