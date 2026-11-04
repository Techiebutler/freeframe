'use client'

import * as React from 'react'
import useSWR from 'swr'
import * as Switch from '@radix-ui/react-switch'
import { Check, Copy, Loader2, Plus } from 'lucide-react'
import { api } from '@/lib/api'
import {
  MCP_URL, countdown, createPairingCode, listAgents, mcpAddCommand, pairInstruction,
  revokeAgent, setAgentsMayApprove, type PairingCode, type ProjectAgent,
} from '@/lib/agents'
import { ProgramBadge } from './program-badge'

function lastUsed(iso: string | null): string {
  if (!iso) return 'Not used yet'
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))
  if (mins < 1) return 'Last used just now'
  if (mins < 60) return `Last used ${mins} min ago`
  if (mins < 1440) return `Last used ${Math.round(mins / 60)} h ago`
  return `Last used ${Math.round(mins / 1440)} d ago`
}

function PairingCard({ projectId }: { projectId: string }) {
  const [pairing, setPairing] = React.useState<PairingCode | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [copied, setCopied] = React.useState(false)
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (!pairing) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [pairing])

  const generate = async () => {
    setBusy(true); setError(''); setCopied(false)
    try { setPairing(await createPairingCode(projectId)); setNow(Date.now()) }
    catch { setError('Could not create a code. Try again.') }
    finally { setBusy(false) }
  }

  const left = pairing ? countdown(pairing.expires_at, now) : null
  const block = pairing ? `${mcpAddCommand(MCP_URL)}\n${pairInstruction(pairing.code)}` : ''
  const copy = async () => {
    try { await navigator.clipboard.writeText(block); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    catch { setError('Copy failed. Select the text and copy it by hand.') }
  }

  return (
    <section aria-labelledby="connect-agent-h" className="rounded-2xl border border-border bg-bg-secondary p-5">
      <h2 id="connect-agent-h" className="text-base font-semibold text-text-primary">Connect an agent</h2>
      <p className="mt-1 text-sm text-text-secondary">Let Claude Code, Codex or Hermes hand in files and read your feedback. One code per agent.</p>

      {!pairing || left?.expired ? (
        <div className="mt-4">
          {left?.expired && <p role="status" className="mb-3 text-sm text-text-secondary">That code expired. Create a new one.</p>}
          <button type="button" onClick={generate} disabled={busy}
            className="press inline-flex h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-text-inverse hover:bg-accent-hover disabled:opacity-60">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            {left?.expired ? 'Create new code' : 'Create pairing code'}
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-mono text-3xl font-semibold tracking-[0.18em] text-text-primary" aria-label={`Pairing code ${pairing.code.split('').join(' ')}`}>{pairing.code}</p>
            <p className="text-sm tabular-nums text-text-secondary" role="timer">Expires in {left!.label}</p>
          </div>
          <div className="rounded-xl border border-border bg-bg-primary p-3">
            <pre className="whitespace-pre-wrap break-all font-mono text-[0.8125rem] leading-relaxed text-text-primary">{block}</pre>
          </div>
          <button type="button" onClick={copy}
            className="press inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-text-inverse hover:bg-accent-hover sm:w-auto">
            {copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Copied' : 'Copy both lines'}
          </button>
          <p className="text-[0.8125rem] text-text-secondary">Run the first line in the agent&apos;s terminal, then tell the agent the second line.</p>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-status-error">{error}</p>}
    </section>
  )
}

function AgentRow({ agent, onRevoke }: { agent: ProjectAgent; onRevoke: (a: ProjectAgent) => Promise<void> }) {
  const [confirming, setConfirming] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium text-text-primary"><span className="truncate">{agent.agent_name}</span><ProgramBadge program={agent.program} /></p>
        <p className="mt-0.5 text-[0.8125rem] text-text-secondary">{lastUsed(agent.last_used_at)}</p>
      </div>
      {confirming ? (
        <div className="flex items-center gap-2" role="group" aria-label={`Revoke ${agent.agent_name}`}>
          <button type="button" onClick={() => setConfirming(false)} className="press min-h-11 rounded-full px-4 text-sm text-text-secondary hover:bg-bg-hover">Keep</button>
          <button type="button" disabled={busy} onClick={async () => { setBusy(true); await onRevoke(agent); setBusy(false) }}
            className="press min-h-11 rounded-full bg-status-error px-4 text-sm font-semibold text-white disabled:opacity-60">Revoke access</button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} aria-label={`Revoke ${agent.agent_name}`} className="press min-h-11 rounded-full px-4 text-sm font-medium text-status-error hover:bg-bg-hover">
          Revoke
        </button>
      )}
    </li>
  )
}

export function ConnectAgent({ projectId }: { projectId: string }) {
  const agentsKey = `/projects/${projectId}/agents`
  const { data: agents, error, mutate } = useSWR<ProjectAgent[]>(agentsKey, () => listAgents(projectId))
  const { data: project, mutate: mutateProject } = useSWR<{ agents_may_approve?: boolean }>(`/projects/${projectId}`, () => api.get<{ agents_may_approve?: boolean }>(`/projects/${projectId}`))
  const [toggleError, setToggleError] = React.useState('')
  const [revokeError, setRevokeError] = React.useState('')
  const mayApprove = !!project?.agents_may_approve
  const active = (agents || []).filter(a => !a.revoked)

  const toggle = async (value: boolean) => {
    setToggleError('')
    try {
      await mutateProject(async current => { await setAgentsMayApprove(projectId, value); return { ...current, agents_may_approve: value } }, false)
    } catch { setToggleError('Could not save. The setting is unchanged.') }
  }
  const revoke = async (agent: ProjectAgent) => {
    setRevokeError('')
    try { await revokeAgent(projectId, agent.user_id); await mutate() }
    catch { setRevokeError(`Could not revoke ${agent.agent_name}. Try again.`) }
  }

  return (
    <div className="space-y-6">
      <PairingCard projectId={projectId} />

      <section aria-labelledby="agents-h" className="rounded-2xl border border-border bg-bg-secondary p-5">
        <h2 id="agents-h" className="text-base font-semibold text-text-primary">Connected agents</h2>
        {error ? <p role="alert" className="mt-3 text-sm text-text-secondary">Could not load agents. <button className="min-h-11 font-medium text-accent" onClick={() => mutate()}>Retry</button></p>
          : !agents ? <div className="skeleton-shimmer mt-3 h-16 animate-shimmer rounded-xl" />
          : active.length === 0 ? <p className="mt-3 text-sm text-text-secondary">No agents yet. Create a code above and give it to one.</p>
          : <ul className="mt-2 divide-y divide-border">{active.map(a => <AgentRow key={a.user_id} agent={a} onRevoke={revoke} />)}</ul>}
        {revokeError && <p role="alert" className="mt-2 text-sm text-status-error">{revokeError}</p>}
      </section>

      <section className="rounded-2xl border border-border bg-bg-secondary p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <label id="may-approve-l" htmlFor="may-approve" className="text-sm font-medium text-text-primary">Agents may approve</label>
            <p className="mt-0.5 text-[0.8125rem] text-text-secondary">Off by default. Agents can hand in and fix, but only you approve.</p>
          </div>
          <Switch.Root id="may-approve" checked={mayApprove} onCheckedChange={toggle} aria-labelledby="may-approve-l"
            className="relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full bg-bg-tertiary p-0.5 transition-colors data-[state=checked]:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-secondary">
            <Switch.Thumb className="pointer-events-none block h-6 w-6 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-5" />
          </Switch.Root>
        </div>
        {toggleError && <p role="alert" className="mt-2 text-sm text-status-error">{toggleError}</p>}
      </section>
    </div>
  )
}
