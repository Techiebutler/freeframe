'use client'

import * as React from 'react'
import useSWR from 'swr'
import * as Switch from '@radix-ui/react-switch'
import { Check, Copy, Loader2, Plus } from 'lucide-react'
import { api } from '@/lib/api'
import {
  KEY_PROGRAMS, KIT_URL, importPrompt, MCP_URL, PROGRAM_LABEL, agentPrompt, countdown, createAgentKey, createPairingCode, kitInstruction,
  listAgents, mcpAddCommand, pairInstruction, revokeAgent, setAgentsMayApprove, setupLine,
  type AgentKeyReply, type AgentProgram, type AgentScope, type PairingCode, type ProjectAgent,
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

const SCOPES: { value: AgentScope; label: string; hint: string }[] = [
  { value: 'deliver', label: 'Hand in and read', hint: 'Uploads new versions, reads reviews and feedback.' },
  { value: 'read', label: 'Read only', hint: 'Reads reviews and feedback. Cannot upload.' },
]

function CopyButton({ text, label, primary }: { text: string; label: string; primary?: boolean }) {
  const [copied, setCopied] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setFailed(false); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    catch { setFailed(true) }
  }
  return (
    <>
      <button type="button" onClick={copy}
        className={primary
          ? 'press inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-accent px-5 text-[0.9375rem] font-semibold text-text-inverse hover:bg-accent-hover sm:w-auto'
          : 'press inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-medium text-text-primary hover:bg-bg-hover'}>
        {copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Copied' : label}
      </button>
      {failed && <p role="alert" className="text-sm text-status-error">Copy failed. Select the text and copy it by hand.</p>}
    </>
  )
}

/** Agents page (spec C): pick the AI and its rights, get a key once, paste one prompt. */
function KeyCard({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const [program, setProgram] = React.useState<AgentProgram>('claude-code')
  const [scope, setScope] = React.useState<AgentScope>('deliver')
  const [made, setMade] = React.useState<(AgentKeyReply & { program: AgentProgram }) | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')

  const create = async () => {
    setBusy(true); setError('')
    try { setMade({ ...(await createAgentKey(projectId, program, scope)), program }); onCreated() }
    catch { setError('Could not create a key. Try again.') }
    finally { setBusy(false) }
  }
  const extra = made ? setupLine(made.program, made.agent_key) : null
  const radio = 'peer sr-only'
  const pill = 'press flex min-h-11 cursor-pointer items-center rounded-full border border-border px-4 text-sm text-text-secondary hover:bg-bg-hover peer-checked:border-transparent peer-checked:bg-accent-muted peer-checked:font-semibold peer-checked:text-accent peer-focus-visible:ring-2 peer-focus-visible:ring-text-secondary'

  return (
    <section aria-labelledby="connect-ai-h" className="playbook-surface p-5 sm:p-6">
      <h2 id="connect-ai-h" className="text-[1.0625rem] font-semibold tracking-tight text-text-primary">Connect your AI</h2>
      <p className="mt-1 text-sm text-text-secondary">Your AI hands in cuts and reads your feedback on its own. You only pass on one prompt.</p>

      {!made ? (
        <div className="mt-5 space-y-5">
          <fieldset>
            <legend className="text-sm font-medium text-text-primary">Which AI?</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {KEY_PROGRAMS.map(p => (
                <label key={p}>
                  <input type="radio" name="ai-program" value={p} checked={program === p} onChange={() => setProgram(p)} className={radio} />
                  <span className={pill}>{PROGRAM_LABEL[p]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="text-sm font-medium text-text-primary">What may it do?</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {SCOPES.map(s => (
                <label key={s.value} className="block">
                  <input type="radio" name="ai-scope" value={s.value} checked={scope === s.value} onChange={() => setScope(s.value)} className={radio} />
                  <span className="press block min-h-11 cursor-pointer rounded-xl border border-border px-4 py-3 hover:bg-bg-hover peer-checked:border-transparent peer-checked:bg-accent-muted peer-focus-visible:ring-2 peer-focus-visible:ring-text-secondary">
                    <span className="block text-sm font-medium text-text-primary">{s.label}</span>
                    <span className="mt-0.5 block text-[0.8125rem] text-text-secondary">{s.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <button type="button" onClick={create} disabled={busy}
              className="press inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-accent px-5 text-[0.9375rem] font-semibold text-text-inverse hover:bg-accent-hover disabled:opacity-60 sm:w-auto">
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}Create key
            </button>
            <p className="mt-2 text-[0.8125rem] text-text-secondary">A new key for the same AI replaces its old one.</p>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <p role="status" className="text-sm text-text-primary">
            <span className="font-medium">Key for {PROGRAM_LABEL[made.program]} is ready.</span>{' '}
            <span className="text-text-secondary">It is shown only now. Paste this into {PROGRAM_LABEL[made.program] === 'Other' ? 'your AI' : PROGRAM_LABEL[made.program]}:</span>
          </p>
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <pre data-testid="agent-prompt" className="whitespace-pre-wrap font-mono [overflow-wrap:anywhere] text-[0.9375rem] leading-relaxed text-text-primary">{agentPrompt(made.agent_key)}</pre>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton text={agentPrompt(made.agent_key)} label="Copy prompt" primary />
            <button type="button" onClick={() => setMade(null)} className="press min-h-11 rounded-full px-4 text-sm text-text-secondary hover:bg-bg-hover">Done</button>
          </div>
          {extra && (
            <div className="pt-2">
              <p className="text-[0.8125rem] font-medium text-text-secondary">{extra.label}</p>
              <pre className="mt-1 whitespace-pre-wrap rounded-2xl [overflow-wrap:anywhere] border border-border bg-bg-secondary p-3 font-mono text-[0.8125rem] leading-relaxed text-text-primary">{extra.text}</pre>
              <CopyButton text={extra.text} label="Copy" />
            </div>
          )}
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-status-error">{error}</p>}
    </section>
  )
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
  const line = pairing ? kitInstruction(pairing.code) : ''
  const mcpBlock = pairing ? `${mcpAddCommand(MCP_URL)}\n${pairInstruction(pairing.code)}` : ''
  const copy = async () => {
    try { await navigator.clipboard.writeText(line); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    catch { setError('Copy failed. Select the text and copy it by hand.') }
  }

  return (
    <details className="group playbook-surface px-5 sm:px-6">
      <summary className="flex min-h-14 cursor-pointer items-center text-sm font-medium text-text-primary">Pair with a code instead</summary>
      <div className="pb-5">
      <p className="text-sm text-text-secondary">The key never shows up in a chat. The code works once, for 15 minutes.</p>

      {!pairing || left?.expired ? (
        <div className="mt-4">
          {left?.expired && <p role="status" className="mb-3 text-sm text-text-secondary">That code expired. Create a new one.</p>}
          <button type="button" onClick={generate} disabled={busy}
            className="press inline-flex h-11 items-center gap-2 rounded-full border border-border px-5 text-sm font-semibold text-text-primary hover:bg-bg-hover disabled:opacity-60">
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
          <p className="text-sm text-text-secondary">Tell Claude Code this line. It needs the <a href={KIT_URL} target="_blank" rel="noreferrer" className="font-medium text-text-primary underline underline-offset-2">AI Builder Starter Kit</a>.</p>
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <pre className="whitespace-pre-wrap break-all font-mono text-[0.9375rem] leading-relaxed text-text-primary">{line}</pre>
          </div>
          <button type="button" onClick={copy}
            className="press inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-accent px-5 text-[0.9375rem] font-semibold text-text-inverse hover:bg-accent-hover sm:w-auto">
            {copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Copied' : 'Copy'}
          </button>
          <details className="text-[0.8125rem] text-text-secondary">
            <summary className="min-h-11 cursor-pointer content-center font-medium hover:text-text-primary">Codex, Hermes or Claude without the kit</summary>
            <p className="mb-2">Run the first line in the agent&apos;s terminal, then tell the agent the second line.</p>
            <pre className="whitespace-pre-wrap break-all rounded-2xl border border-border bg-bg-secondary p-3 font-mono leading-relaxed text-text-primary">{mcpBlock}</pre>
          </details>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-status-error">{error}</p>}
      </div>
    </details>
  )
}

function AgentRow({ agent, onRevoke }: { agent: ProjectAgent; onRevoke: (a: ProjectAgent) => Promise<void> }) {
  const [confirming, setConfirming] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium text-text-primary"><span className="truncate">{agent.agent_name}</span><ProgramBadge program={agent.program} />{agent.scope === 'read' && <span className="text-[0.75rem] text-text-secondary">Read only</span>}</p>
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

export function ConnectAgent({ projectId, brandName }: { projectId: string; brandName?: string }) {
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
    <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-6">
        <KeyCard projectId={projectId} onCreated={() => mutate()} />
        <PairingCard projectId={projectId} />
      </div>
      <div className="min-w-0 space-y-6">

      <section aria-labelledby="agents-h" className="playbook-surface p-5 sm:p-6">
        <h2 id="agents-h" className="text-[1.0625rem] font-semibold tracking-tight text-text-primary">Connected AIs</h2>
        {error ? <p role="alert" className="mt-3 text-sm text-text-secondary">Could not load agents. <button className="min-h-11 font-medium text-accent" onClick={() => mutate()}>Retry</button></p>
          : !agents ? <div className="skeleton-shimmer mt-3 h-16 animate-shimmer rounded-xl" />
          : active.length === 0 ? <p className="mt-3 text-sm text-text-secondary">No AI connected yet. Create a key above.</p>
          : <ul className="mt-2 divide-y divide-border">{active.map(a => <AgentRow key={a.user_id} agent={a} onRevoke={revoke} />)}</ul>}
        {revokeError && <p role="alert" className="mt-2 text-sm text-status-error">{revokeError}</p>}
      </section>

      {active.length > 0 && (
        <section aria-labelledby="import-h" className="playbook-surface p-5 sm:p-6">
          <h2 id="import-h" className="text-[1.0625rem] font-semibold tracking-tight text-text-primary">Import past feedback</h2>
          <p className="mt-1 text-sm text-text-secondary">Your AI finds the feedback you already gave and turns it into rules.</p>
          <div className="mt-3"><CopyButton text={importPrompt(brandName)} label="Copy" /></div>
        </section>
      )}

      <section className="playbook-surface p-5 sm:p-6">
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
    </div>
  )
}
