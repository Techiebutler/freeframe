'use client'

import * as React from 'react'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import * as Tabs from '@radix-ui/react-tabs'
import { AlertTriangle, ChevronLeft, Lock, Settings2, Users } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/shared/skeleton'
import { usePageTitle } from '@/hooks/use-page-title'
import { useAuthStore } from '@/stores/auth-store'
import { useBranding } from '@/components/shared/branding-provider'
import { ProjectGeneralTab } from '@/components/projects/settings/general-tab'
import { ProjectPeopleTab } from '@/components/projects/settings/people-tab'
import { ProjectDangerTab } from '@/components/projects/settings/danger-tab'
import type { Project, ProjectMember } from '@/types'

const TABS = [
  { value: 'general', label: 'General', icon: Settings2 },
  { value: 'people', label: 'People', icon: Users },
  { value: 'danger', label: 'Danger', icon: AlertTriangle },
] as const

type TabValue = (typeof TABS)[number]['value']

function toTab(value: string | null): TabValue {
  return TABS.some((t) => t.value === value) ? (value as TabValue) : 'general'
}

/**
 * Project settings: General (details, cover, share page branding), People
 * and Danger, each reachable as `?tab=`. An unknown tab opens General.
 *
 * Owner only, as the API is for everything on it: anyone else gets a short
 * card rather than forms whose every save would be refused.
 */
export default function ProjectSettingsPage() {
  const params = useParams()
  const projectId = params.id as string
  const router = useRouter()
  const searchParams = useSearchParams()
  const requestedTab = searchParams.get('tab')
  const userId = useAuthStore((s) => s.user?.id)
  const { poweredByFreeframe } = useBranding()

  const projectKey = `/projects/${projectId}`
  const {
    data: project,
    error: projectError,
    mutate: mutateProject,
  } = useSWR<Project>(projectKey, () => api.get<Project>(projectKey))
  // GET /projects/{id} names the caller's role. The member list is the
  // fallback for a response that does not.
  const needsMembers = !!project && project.role == null
  const { data: members, error: membersError } = useSWR<ProjectMember[]>(
    needsMembers ? `/projects/${projectId}/members` : null,
    (key: string) => api.get<ProjectMember[]>(key),
  )

  usePageTitle(project ? `${project.name} settings` : null)

  const [tab, setTab] = React.useState<TabValue>(() => toTab(requestedTab))
  // A link to another tab of this page (the toolbar's People button, say)
  // changes the query without remounting the page.
  const [seenRequest, setSeenRequest] = React.useState(requestedTab)
  if (requestedTab !== seenRequest) {
    setSeenRequest(requestedTab)
    setTab(toTab(requestedTab))
  }

  function selectTab(value: string) {
    const next = toTab(value)
    setTab(next)
    router.replace(`/projects/${projectId}/settings?tab=${next}`, { scroll: false })
  }

  const role = project?.role ?? members?.find((m) => m.user_id === userId)?.role ?? null
  const roleKnown = !!project && (project.role != null || members !== undefined || !!membersError)

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
    // People and Danger end in the bottom-right corner, where the shell floats
    // "Powered by FreeFrame" above the page, so they leave room below their
    // last control to scroll it clear. General needs none: its save bar
    // reserves the corner itself. See the badge in (dashboard)/layout.tsx.
    const clearBadge = poweredByFreeframe ? 'pb-[calc(3.5rem+env(safe-area-inset-bottom))]' : 'pb-6'
    body = (
      <Tabs.Root value={tab} onValueChange={selectTab}>
        {/* Scrolls sideways on a phone rather than wrapping. */}
        <Tabs.List
          aria-label="Project settings"
          className="-mx-4 flex overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0 [scrollbar-width:none]"
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
        <Tabs.Content value="general" forceMount className="pt-6 data-[state=inactive]:hidden">
          <ProjectGeneralTab project={project} />
        </Tabs.Content>
        <Tabs.Content value="people" className={cn('pt-6', clearBadge)}>
          <ProjectPeopleTab projectId={projectId} />
        </Tabs.Content>
        <Tabs.Content value="danger" className={cn('pt-6', clearBadge)}>
          <ProjectDangerTab projectId={projectId} projectName={project.name} />
        </Tabs.Content>
      </Tabs.Root>
    )
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 pt-6 sm:px-6">
      <div className="space-y-1">
        <Link
          href={`/projects/${projectId}`}
          className="inline-flex items-center gap-1 text-xs text-text-tertiary hover:text-text-primary transition-colors"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          {project?.name ?? 'Back to project'}
        </Link>
        <h1 className="text-xl font-semibold text-text-primary">Project settings</h1>
      </div>
      {body}
    </div>
  )
}
