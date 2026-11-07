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
import type { Project } from '@/types'

// Only the brand's owner connects an AI; editors keep joining through share links.
const canConnect = (p: Project) => !p.role || p.role === 'owner'

function Agents() {
  usePageTitle('Agents')
  const router = useRouter()
  const params = useSearchParams()
  const { data: projects, error, mutate } = useSWR<Project[]>('/projects', () => api.get<Project[]>('/projects'))
  const brands = (projects ?? []).filter(canConnect)
  const wanted = params.get('project')
  const projectId = brands.find(p => p.id === wanted)?.id ?? brands[0]?.id

  return (
    <div className="page-in mx-auto w-full max-w-2xl px-4 pb-24 pt-8 sm:px-8 sm:pt-12">
      <h1 className="text-[34px] font-bold leading-tight tracking-[-0.02em] text-text-primary">Agents</h1>
      <p className="mt-2 text-[15px] text-text-secondary">Connect Claude Code, Codex, ChatGPT or Cursor. Your AI uploads cuts, reads the review and your feedback, and pushes the fix.</p>

      {error ? (
        <p role="alert" className="mt-8 text-sm text-text-secondary">Could not load your brands. <button className="min-h-11 font-medium text-accent" onClick={() => mutate()}>Retry</button></p>
      ) : !projects ? (
        <div className="skeleton-shimmer mt-8 h-64 animate-shimmer rounded-2xl" />
      ) : !projectId ? (
        <p className="mt-8 text-sm text-text-secondary">You need a brand you own before an AI can join it.</p>
      ) : (
        <div className="mt-8 space-y-6">
          {brands.length > 1 && (
            <div>
              <label htmlFor="agent-brand" className="text-sm font-medium text-text-primary">Brand</label>
              <select id="agent-brand" value={projectId} onChange={e => router.replace(`/agents?project=${e.target.value}`)}
                className="mt-2 block h-11 w-full rounded-xl border border-border bg-bg-secondary px-3 text-[15px] text-text-primary sm:w-80">
                {brands.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <p className="mt-1.5 text-[0.8125rem] text-text-secondary">One key works for one brand only.</p>
            </div>
          )}
          <ConnectAgent key={projectId} projectId={projectId} />
        </div>
      )}
    </div>
  )
}

export default function AgentsPage() {
  return <React.Suspense fallback={null}><Agents /></React.Suspense>
}
