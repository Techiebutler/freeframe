'use client'

import * as React from 'react'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import * as Tabs from '@radix-ui/react-tabs'
import { ChevronDown, ChevronRight, Lock, Settings2, Shield, Users } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { effectiveProjectRole } from '@/lib/project-role'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/shared/skeleton'
import { usePageTitle } from '@/hooks/use-page-title'
import { useAuthStore } from '@/stores/auth-store'
import { useBranding } from '@/components/shared/branding-provider'
import { ProjectGeneralTab } from '@/components/projects/settings/general-tab'
import { ProjectPeopleTab } from '@/components/projects/settings/people-tab'
import { ProjectDangerTab } from '@/components/projects/settings/danger-tab'
import { ProjectPoster } from '@/components/projects/project-poster'
import { ProjectChip } from '@/components/settings/project-list'
import type { Project, ProjectMember } from '@/types'

const TABS = [
  { value: 'general', label: 'General', icon: Settings2 },
  { value: 'people', label: 'People', icon: Users },
] as const

type TabValue = (typeof TABS)[number]['value']

function toTab(value: string | null): TabValue {
  return TABS.some((t) => t.value === value) ? (value as TabValue) : 'general'
}

/**
 * Project settings: General (details, cover, share page branding, and a
 * collapsed Delete project row at its end) and People, each reachable as
 * `?tab=`. An unknown tab opens General; `?tab=danger` opens General with the
 * Delete project row open.
 *
 * Owner only, as the API is for everything on it: anyone else gets a short
 * card rather than forms whose every save would be refused. An instance admin
 * counts as an owner here, on every live project, because the API accepts its
 * saves; `effectiveProjectRole` is the one place that says so.
 */
export default function ProjectSettingsPage() {
  const params = useParams()
  const projectId = params.id as string
  const router = useRouter()
  const searchParams = useSearchParams()
  const requestedTab = searchParams.get('tab')
  const userId = useAuthStore((s) => s.user?.id)
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin)
  const { poweredByFreeframe } = useBranding()

  const projectKey = `/projects/${projectId}`
  const {
    data: project,
    error: projectError,
    mutate: mutateProject,
  } = useSWR<Project>(projectKey, () => api.get<Project>(projectKey))
  // GET /projects/{id} names the caller's role. The member list is the
  // fallback for a response that does not, and an instance admin needs
  // neither: it is an owner here whatever its membership says.
  const needsMembers = !!project && project.role == null && !isSuperAdmin
  const { data: members, error: membersError } = useSWR<ProjectMember[]>(
    needsMembers ? `/projects/${projectId}/members` : null,
    (key: string) => api.get<ProjectMember[]>(key),
  )

  usePageTitle(project ? `${project.name} settings` : null)

  const [tab, setTab] = React.useState<TabValue>(() => toTab(requestedTab))
  // Delete project is a collapsed row at the end of General. `?tab=danger`
  // (the card menu's Delete Project) opens it.
  const [deleteOpen, setDeleteOpen] = React.useState(requestedTab === 'danger')
  const deleteId = React.useId()
  const deleteRowRef = React.useRef<HTMLDivElement>(null)
  // A link to another tab of this page (the toolbar's People button, say)
  // changes the query without remounting the page.
  const [seenRequest, setSeenRequest] = React.useState(requestedTab)
  if (requestedTab !== seenRequest) {
    setSeenRequest(requestedTab)
    setTab(toTab(requestedTab))
    if (requestedTab === 'danger') setDeleteOpen(true)
  }
  // Picking another project in the rail keeps this component mounted, so the
  // row starts closed again for it.
  const [seenProject, setSeenProject] = React.useState(projectId)
  if (projectId !== seenProject) {
    setSeenProject(projectId)
    setDeleteOpen(requestedTab === 'danger')
  }

  function selectTab(value: string) {
    const next = toTab(value)
    setTab(next)
    router.replace(`/settings/projects/${projectId}?tab=${next}`, { scroll: false })
  }

  const role = effectiveProjectRole(
    project?.role ?? members?.find((m) => m.user_id === userId)?.role,
    isSuperAdmin,
  )
  const roleKnown = !!project && (isSuperAdmin || project.role != null || members !== undefined || !!membersError)
  const showForms = !projectError && !!project && roleKnown && role === 'owner'

  // Bring the Delete project row into view when the page was asked for it.
  const wantsDelete = requestedTab === 'danger'
  React.useEffect(() => {
    if (wantsDelete && showForms) deleteRowRef.current?.scrollIntoView?.({ block: 'center' })
  }, [wantsDelete, showForms, projectId])

  let body: React.ReactNode
  if (projectError) {
    body = (
      <div role="alert" className="rounded-xl border border-border bg-bg-secondary p-6 space-y-3">
        <p className="text-sm text-text-secondary">
          This project could not be loaded
          {projectError instanceof Error && projectError.message ? `: ${projectError.message}` : '.'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void mutateProject()}>
          Retry
        </Button>
      </div>
    )
  } else if (!project || !roleKnown) {
    body = (
      <div className="space-y-4" aria-label="Loading project settings">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  } else if (role !== 'owner') {
    body = (
      <div className="flex items-start gap-3 rounded-xl border border-border bg-bg-secondary p-6">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
        <p className="text-sm text-text-secondary">Only the project owner can change settings.</p>
      </div>
    )
  } else {
    // People and the Delete project row end in the bottom-right corner, where
    // the shell floats "Powered by FreeFrame" above the page, so they leave room
    // below their last control to scroll it clear. General's save bar reserves
    // the corner itself, so there the row carries the reserve. See the badge in
    // (dashboard)/layout.tsx.
    const clearBadge = poweredByFreeframe ? 'pb-[calc(3.5rem+env(safe-area-inset-bottom))]' : 'pb-6'
    body = (
      <>
        {isSuperAdmin && project.role == null && (
          <div
            role="note"
            className="flex items-start gap-3 rounded-xl border border-border bg-bg-secondary p-4"
          >
            <Shield className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
            <p className="text-sm text-text-secondary">
              You are not a member of this project. You are managing it as an instance admin, and
              this access is written to the activity log.
            </p>
          </div>
        )}
        {/* Keyed so a draft in General never carries over to another project:
            ProjectGeneralTab takes its saved values once. */}
        <Tabs.Root key={projectId} value={tab} onValueChange={selectTab}>
          {/* From `md` the rail's General and People links do this job. Scrolls
              sideways on a phone rather than wrapping. */}
          <Tabs.List
            aria-label="Project settings"
            className="-mx-4 flex overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0 [scrollbar-width:none] md:hidden"
          >
            {TABS.map(({ value, label, icon: Icon }) => (
              <Tabs.Trigger
                key={value}
                value={value}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 -mb-px px-3 py-2 text-sm transition-colors',
                  'border-transparent text-text-secondary hover:text-text-primary',
                  'data-[state=active]:border-accent data-[state=active]:text-text-primary',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          {/* General stays mounted behind the other tabs so its unsaved draft
              survives a look at them. */}
          <Tabs.Content value="general" forceMount className="pt-6 md:pt-0 data-[state=inactive]:hidden">
            <ProjectGeneralTab project={project} />
            <div ref={deleteRowRef} className={cn('mt-6 border-t border-border pt-4', clearBadge)}>
              <button
                type="button"
                aria-expanded={deleteOpen}
                aria-controls={deleteId}
                onClick={() => setDeleteOpen((o) => !o)}
                className="flex items-center gap-1.5 rounded text-left text-sm text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <ChevronRight
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform',
                    deleteOpen && 'rotate-90',
                  )}
                />
                Delete project
              </button>
              {deleteOpen && (
                <div id={deleteId} className="pt-3">
                  <ProjectDangerTab projectId={projectId} projectName={project.name} />
                </div>
              )}
            </div>
          </Tabs.Content>
          <Tabs.Content value="people" className={cn('pt-6 md:pt-0', clearBadge)}>
            <ProjectPeopleTab projectId={projectId} />
          </Tabs.Content>
        </Tabs.Root>
      </>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pt-6 sm:px-6">
      {/* Phone only: the rail is not drawn there, so the project list is one tap away. */}
      <Link
        href="/settings/projects"
        aria-label="Choose project"
        className="flex h-10 w-full items-center gap-2.5 rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary md:hidden"
      >
        {project && (
          <span aria-hidden="true" className="relative h-6 w-6 shrink-0 overflow-hidden rounded">
            <ProjectPoster project={project} />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{project?.name ?? 'Choose a project'}</span>
        {showForms && <ProjectChip role={project?.role} />}
        <ChevronDown className="h-4 w-4 shrink-0 text-text-tertiary" />
      </Link>
      {body}
    </div>
  )
}
