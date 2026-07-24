'use client'

import * as React from 'react'
import Link from 'next/link'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { MoreHorizontal, Settings, Trash2, Globe } from 'lucide-react'
import { cn, formatRelativeTime, formatBytes } from '@/lib/utils'
import { api } from '@/lib/api'
import { ProjectSettingsDialog } from './project-settings-dialog'
import type { Project } from '@/types'

function PosterFallback({ count, className }: { count: number; className?: string }) {
  return (
    <div className={cn('ff-dotgrid flex h-full w-full items-center justify-center bg-bg-tertiary', className)}>
      <span className="font-dot text-[76px] font-black tracking-[0.04em] text-text-tertiary opacity-50">
        {String(Math.min(count, 99)).padStart(2, '0')}
      </span>
    </div>
  )
}

interface ProjectCardProps {
  project: Project
  showRole?: boolean
  isOwner?: boolean
  className?: string
  onMutate?: () => void
}

export function ProjectCard({
  project,
  showRole,
  isOwner,
  className,
  onMutate,
}: ProjectCardProps) {
  const assetCount = project.asset_count ?? 0
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  const handleDelete = async () => {
    if (!confirm(`Delete "${project.name}"? This action cannot be undone.`)) return
    setDeleting(true)
    try {
      await api.delete(`/projects/${project.id}`)
      onMutate?.()
    } catch {
      // silently fail
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <div className={cn('group relative', className)}>
        <Link
          href={`/projects/${project.id}`}
          className="block rounded-lg overflow-hidden bg-bg-secondary border border-border hover:border-border-strong transition-colors duration-200"
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
              <PosterFallback count={assetCount} />
            )}

            <div className="absolute inset-x-0 bottom-0 h-[84px] bg-gradient-to-t from-[var(--scrim)] to-transparent" />

            {/* Project name overlay */}
            <div className="absolute inset-x-0 bottom-0 p-3">
              <p className="text-[15px] font-semibold text-white line-clamp-2">
                {project.name}
              </p>
              {project.description && (
                <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-white/70 line-clamp-1 mt-0.5">
                  {project.description}
                </p>
              )}
            </div>

            {/* Public/role badges */}
            <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5">
              {/* needs-review corner dot: blocked on a Project.needs_review field */}
              {project.is_quick_share && (
                <span className="inline-flex items-center rounded-none bg-black/55 backdrop-blur px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em] text-white/90">
                  QUICK SHARES
                </span>
              )}
              {project.is_public && (
                <span className="inline-flex items-center gap-1 rounded-none bg-black/55 backdrop-blur px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em] text-white/90">
                  <Globe className="h-2.5 w-2.5" />
                  Public
                </span>
              )}
              {showRole && project.role && project.role !== 'owner' && (
                <span className="inline-flex items-center rounded-none bg-black/55 backdrop-blur px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em] text-white/90">
                  {project.role}
                </span>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-3 py-2.5">
            <span className="font-mono text-[10px] tracking-[0.04em] text-text-tertiary">
              {assetCount > 0
                ? `${assetCount} item${assetCount !== 1 ? 's' : ''} · ${formatBytes(project.storage_bytes ?? 0)}`
                : `Updated ${formatRelativeTime(project.created_at)}`}
            </span>
          </div>
        </Link>

        {/* Context menu trigger */}
        {(isOwner || project.role === 'owner') && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                className="absolute bottom-2 right-2.5 flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-all opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100"
                onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="z-50 min-w-[180px] rounded border border-border bg-bg-elevated shadow-xl p-1"
                sideOffset={4}
                align="end"
              >
                <DropdownMenu.Label className="px-3 py-1.5 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
                  Project
                </DropdownMenu.Label>

                <DropdownMenu.Item
                  className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                  onSelect={() => setSettingsOpen(true)}
                >
                  <Settings className="h-4 w-4 text-text-tertiary" />
                  Project Settings
                </DropdownMenu.Item>

                <DropdownMenu.Separator className="my-1 h-px bg-border" />

                <DropdownMenu.Item
                  className="flex items-center gap-2.5 rounded px-3 py-2 text-sm text-accent hover:bg-accent-muted cursor-pointer outline-none transition-colors"
                  onSelect={handleDelete}
                  disabled={deleting}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>

      {/* Project Settings Dialog */}
      <ProjectSettingsDialog
        project={project}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onUpdated={() => onMutate?.()}
      />
    </>
  )
}
