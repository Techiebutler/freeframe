'use client'

import * as React from 'react'
import Link from 'next/link'
import { Bell, MoreHorizontal } from 'lucide-react'
import { cn, formatRelativeTime } from '@/lib/utils'
import type { Project } from '@/types'

// Frame.io-inspired gradient presets
const GRADIENT_PRESETS = [
  'from-violet-600 via-purple-600 to-fuchsia-500',
  'from-blue-600 via-indigo-600 to-violet-500',
  'from-emerald-600 via-teal-600 to-cyan-500',
  'from-orange-500 via-amber-500 to-yellow-500',
  'from-rose-600 via-pink-600 to-fuchsia-500',
  'from-cyan-500 via-blue-500 to-indigo-500',
]

function getGradientForProject(projectId: string): string {
  // Deterministic gradient based on project ID
  const hash = projectId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return GRADIENT_PRESETS[hash % GRADIENT_PRESETS.length]
}

interface ProjectCardProps {
  project: Project
  workspaceName?: string
  className?: string
}

export function ProjectCard({
  project,
  workspaceName,
  className,
}: ProjectCardProps) {
  const gradient = getGradientForProject(project.id)

  return (
    <Link
      href={`/projects/${project.id}`}
      className={cn(
        'group relative flex flex-col rounded-xl overflow-hidden',
        'hover:ring-2 hover:ring-accent/50 transition-all duration-200 hover:shadow-xl hover:shadow-black/20',
        className,
      )}
    >
      {/* Gradient background area */}
      <div className={cn(
        'relative h-32 w-full bg-gradient-to-br p-4',
        gradient,
      )}>
        {/* Notification bell icon (top right) */}
        <button
          className="absolute top-3 right-3 flex h-7 w-7 items-center justify-center rounded-full bg-black/20 text-white/80 hover:bg-black/30 hover:text-white transition-colors opacity-0 group-hover:opacity-100"
          onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
          title="Project notifications"
        >
          <Bell className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Info section */}
      <div className="flex flex-col gap-1 bg-bg-secondary p-3 border-x border-b border-border rounded-b-xl">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-text-primary line-clamp-1 group-hover:text-accent transition-colors">
              {project.name}
            </p>
            {workspaceName && (
              <p className="text-2xs text-text-tertiary line-clamp-1 mt-0.5">
                {workspaceName}
              </p>
            )}
          </div>
        </div>

        {/* Footer row */}
        <div className="flex items-center justify-between mt-1">
          <span className="text-2xs text-text-tertiary">
            Created {formatRelativeTime(project.created_at)}
          </span>
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-bg-hover hover:text-text-secondary transition-colors opacity-0 group-hover:opacity-100"
            onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
            title="More options"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>
      </div>
    </Link>
  )
}
