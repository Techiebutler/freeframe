'use client'

import * as React from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { FolderOpen, Search } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { effectiveProjectRole } from '@/lib/project-role'
import { useAuthStore } from '@/stores/auth-store'
import { useBranding } from '@/components/shared/branding-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/skeleton'
import { ProjectPoster } from '@/components/projects/project-poster'
import type { Project } from '@/types'

const ROW_CLASS =
  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors'
const ROW_ACTIVE = 'bg-bg-hover text-text-primary font-medium'
const ROW_IDLE = 'text-text-secondary hover:bg-bg-hover/70 hover:text-text-primary'

/**
 * Says how the caller reaches a project: `Owner` when its own membership is
 * owner, `Admin` when only the instance Admin role gets it there.
 */
export function ProjectChip({ role }: { role: string | null | undefined }) {
  const isOwner = role === 'owner'
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
        isOwner ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-secondary',
      )}
    >
      {isOwner ? 'Owner' : 'Admin'}
    </span>
  )
}

/** General and People of the selected project, the active one read off `?tab=`. */
function ProjectTabLinks({ projectId }: { projectId: string }) {
  const searchParams = useSearchParams()
  const active = searchParams.get('tab') === 'people' ? 'people' : 'general'
  return (
    <div className="ml-5 hidden space-y-0.5 border-l border-border pl-2 md:block">
      {(['general', 'people'] as const).map((tab) => (
        <Link
          key={tab}
          href={`/settings/projects/${projectId}?tab=${tab}`}
          scroll={false}
          aria-current={active === tab ? 'page' : undefined}
          className={cn(ROW_CLASS, 'py-1.5', active === tab ? ROW_ACTIVE : ROW_IDLE)}
        >
          {tab === 'general' ? 'General' : 'People'}
        </Link>
      ))}
    </div>
  )
}

/**
 * The projects the caller can manage, with a search box: every live project for
 * an Admin, the ones they own for everyone else. Picking one opens its settings.
 *
 * No project is selected for the caller. Opening a private project as a
 * non-member Admin writes an access row, so the Admin has to choose it.
 */
export function SettingsProjectList({ selectedId }: { selectedId?: string }) {
  const user = useAuthStore((s) => s.user)
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin)
  const headingId = React.useId()
  const [query, setQuery] = React.useState('')

  // Wait for the user: until then `isSuperAdmin` is false and an Admin would
  // fire the narrower request first.
  const key = user ? (isSuperAdmin ? '/projects?scope=all' : '/projects') : null
  const { data, error, mutate } = useSWR<Project[]>(key, (k: string) => api.get<Project[]>(k))

  const rows = React.useMemo(
    () =>
      (data ?? [])
        .filter((p) => effectiveProjectRole(p.role, isSuperAdmin) === 'owner')
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [data, isSuperAdmin],
  )

  const needle = query.trim().toLowerCase()
  const shown = needle ? rows.filter((p) => p.name.toLowerCase().includes(needle)) : rows

  // On a phone the list is the whole page, and its last row ends in the corner
  // where the shell floats "Powered by FreeFrame"; leave room to scroll it clear.
  const { poweredByFreeframe } = useBranding()
  const clearBadge = poweredByFreeframe ? 'pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-2' : undefined

  // The list is sorted by name and can hold hundreds of rows, so on a deep link
  // the open project is often below the fold: centre it once when the list
  // arrives. A later pick is a click on a row already in view, so it only moves
  // as far as needed and the list stays under the pointer.
  const selectedRow = React.useRef<HTMLLIElement>(null)
  const centred = React.useRef(false)
  const listReady = rows.length > 0
  React.useEffect(() => {
    const row = selectedRow.current
    if (!row) return
    row.scrollIntoView?.({ block: centred.current ? 'nearest' : 'center' })
    centred.current = true
  }, [selectedId, listReady])

  if (error && !data) {
    return (
      <div className="p-2">
        <div role="alert" className="space-y-3 px-3 py-4">
          <p className="text-sm text-text-secondary">Projects could not be loaded.</p>
          <Button variant="secondary" size="sm" onClick={() => void mutate()}>
            Retry
          </Button>
        </div>
      </div>
    )
  }

  if (!user || !data) {
    return (
      <div className="flex flex-col gap-2 p-2">
        <Input
          type="search"
          aria-label="Search projects"
          placeholder="Search projects"
          icon={<Search className="h-4 w-4" />}
          className="h-9 text-[16px] [@media(hover:hover)]:text-sm"
          value=""
          readOnly
          disabled
        />
        <div aria-label="Loading projects" className="space-y-0.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={FolderOpen}
        title={isSuperAdmin ? 'No projects yet' : "You don't own any projects"}
      />
    )
  }

  return (
    <div className={cn('flex flex-col gap-2 p-2', clearBadge)}>
      <Input
        type="search"
        aria-label="Search projects"
        placeholder="Search projects"
        icon={<Search className="h-4 w-4" />}
        className="h-9 text-[16px] [@media(hover:hover)]:text-sm"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <p id={headingId} className="px-3 text-xs text-text-tertiary">
        {isSuperAdmin ? 'All projects' : 'Your projects'} ({shown.length})
      </p>
      {shown.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-text-tertiary">
          No projects match &quot;{query.trim()}&quot;.
        </p>
      ) : (
        <ul aria-labelledby={headingId} className="space-y-0.5">
          {shown.map((p) => {
            const selected = p.id === selectedId
            return (
              <li key={p.id} ref={selected ? selectedRow : undefined}>
                <Link
                  href={`/settings/projects/${p.id}`}
                  title={p.name}
                  aria-current={selected ? 'page' : undefined}
                  className={cn(ROW_CLASS, selected ? ROW_ACTIVE : ROW_IDLE)}
                >
                  <span
                    aria-hidden="true"
                    className="relative h-6 w-6 shrink-0 overflow-hidden rounded"
                  >
                    <ProjectPoster project={p} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <ProjectChip role={p.role} />
                </Link>
                {selected && (
                  <React.Suspense fallback={null}>
                    <ProjectTabLinks projectId={p.id} />
                  </React.Suspense>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
