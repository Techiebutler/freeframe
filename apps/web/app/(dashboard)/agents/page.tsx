'use client'

/**
 * Agents (spec 2026-11-05 H): its own sidebar page. Alan, 2026-11-07: "wo ist der Sinn, dass wir das so weit
 * verstecken?" - it lived only in Project → Settings → Agents. Editors pair nothing; they join via share links.
 */
import * as React from 'react'
import useSWR from 'swr'
import { useRouter, useSearchParams } from 'next/navigation'
import { usePageTitle } from '@/hooks/use-page-title'
import { api } from '@/lib/api'
import { ConnectAgent } from '@/components/agents/connect-agent'
import { useAuthStore } from '@/stores/auth-store'
import { canManageWorkspace } from '@/lib/workspace-access'
import type { Project } from '@/types'

// Whoever runs the workspace connects an AI, on every brand they own or edit (the API allows editor and up;
// Alan is "editor" on the Aditor workspace). Staff see brand workspaces only, like Brand rules. Freelance
// editors don't run a workspace, so they see none here and keep joining through share links.
const canConnect = (p: Project, staff: boolean) => (!p.role || p.role === 'owner' || p.role === 'editor') && (!staff || !!p.is_workspace)

function Agents() {
  usePageTitle('Agents')
  const router = useRouter()
  const params = useSearchParams()
  const { data: projects, error, mutate } = useSWR<Project[]>('/projects', () => api.get<Project[]>('/projects'))
  const user = useAuthStore(st => st.user)
  const brands = canManageWorkspace(user, projects) ? (projects ?? []).filter(p => canConnect(p, user?.is_staff !== false)).sort((a, b) => a.name.localeCompare(b.name)) : []
  const wanted = params.get('project')
  const projectId = brands.find(p => p.id === wanted)?.id ?? brands[0]?.id

  // Same frame as Overview and Brand rules: wide column, "Title." heading, brand picker top right.
  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 pb-12 pt-6 sm:px-8 lg:px-12 lg:pt-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-[2.125rem] font-semibold leading-tight tracking-[-0.035em]">Agents<span className="text-accent">.</span></h1>
        {brands.length > 1 && projectId && (
          <label className="flex min-w-0 max-w-full items-center gap-3 text-[0.8125rem] text-text-secondary"><span>Brand</span>
            <select value={projectId} onChange={e => router.replace(`/agents?project=${e.target.value}`)} className="field h-11 min-w-0 max-w-[240px]" aria-label="Brand">
              {brands.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
      </div>
      <p className="mt-3 max-w-2xl text-[0.9375rem] leading-relaxed text-text-secondary">Connect Claude Code, Codex, ChatGPT or Cursor. Your AI uploads cuts, reads the review and your feedback, and pushes the fix. One key works for one brand.</p>

      {error ? (
        <div role="alert" className="playbook-surface mt-8 p-5">Could not load your brands. <button type="button" className="min-h-11 px-2 font-medium text-accent" onClick={() => mutate()}>Retry</button></div>
      ) : !projects ? (
        <div className="skeleton-shimmer mt-8 h-64 animate-shimmer rounded-3xl" />
      ) : !projectId ? (
        <p className="playbook-surface mt-8 p-8 text-text-secondary">Only the workspace owner connects an AI.</p>
      ) : (
        <div className="mt-8"><ConnectAgent key={projectId} projectId={projectId} brandName={brands.length === 1 ? brands[0].name : undefined} /></div>
      )}
    </div>
  )
}

export default function AgentsPage() {
  return <React.Suspense fallback={null}><Agents /></React.Suspense>
}
