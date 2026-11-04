'use client'

import * as React from 'react'
import useSWR from 'swr'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, Loader2, Send, X } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { listRequests } from '@/lib/platform'
import {
  acceptRuleSuggestion, agentNames, closeRound, formatSent, listRequestAgents, listRuleSuggestions,
  requestForFolder, roundSummary, startHeartbeat, type RuleSuggestion,
} from '@/lib/agents'

/** Keeps the open feedback round alive while the owner has this tab in front of them. */
export function useRequestHeartbeat(requestId: string | null | undefined) {
  React.useEffect(() => {
    if (!requestId) return
    return startHeartbeat(requestId)
  }, [requestId])
}

export function useAgentRequest(folderId: string | null | undefined, enabled: boolean) {
  const { data: requests } = useSWR(enabled && folderId ? '/requests' : null, listRequests)
  const request = requestForFolder(requests, folderId)
  const { data: agents } = useSWR(request ? `/requests/${request.id}/agents` : null, () => listRequestAgents(request!.id))
  return { request, agents: agents ?? [] }
}

type Phase = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; label: string } | { kind: 'error'; message: string }

export function SendToAgent({ requestId, agents, compact = false }: {
  requestId: string
  agents: { user_id: string; name: string; program: string }[]
  /** Phone layout: the label stays visible, the control gets the full row. */
  compact?: boolean
}) {
  const [phase, setPhase] = React.useState<Phase>({ kind: 'idle' })
  const [roundId, setRoundId] = React.useState<string | null>(null)
  const [suggestions, setSuggestions] = React.useState<RuleSuggestion[]>([])
  const [sheet, setSheet] = React.useState(false)

  const send = async () => {
    setPhase({ kind: 'sending' })
    try {
      const round = await closeRound(requestId)
      setPhase({ kind: 'sent', label: formatSent(agentNames(agents), roundSummary(round)) })
      setRoundId(round.round_id)
      try {
        const found = await listRuleSuggestions(round.round_id)
        if (found.length) { setSuggestions(found); setSheet(true) }
      } catch { /* rule suggestions are optional */ }
    } catch (e) {
      const none = e instanceof ApiError && e.status === 409
      setPhase({ kind: 'error', message: none ? 'No new comments to send yet.' : 'Could not send. Try again.' })
    }
  }

  return (
    <>
      {phase.kind === 'sent' ? (
        <p role="status" aria-live="polite" className={`inline-flex min-h-11 items-center gap-1.5 rounded-full bg-status-success/15 px-3 text-xs font-semibold text-status-success ${compact ? 'w-full justify-center' : ''}`}>
          <Check size={14} aria-hidden="true" />{phase.label}
        </p>
      ) : (
        <div className={compact ? 'w-full' : 'flex flex-col items-end'}>
          <button type="button" onClick={send} disabled={phase.kind === 'sending'}
            className={`press inline-flex h-11 items-center justify-center gap-1.5 rounded-full border border-border px-3.5 text-xs font-semibold text-text-primary hover:bg-bg-hover disabled:opacity-60 ${compact ? 'w-full' : ''}`}>
            {phase.kind === 'sending' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}Send to agent
          </button>
          {phase.kind === 'error' && <p role="alert" className="mt-1 text-xs text-text-secondary">{phase.message}</p>}
        </div>
      )}
      {sheet && roundId && <RulesSheet roundId={roundId} suggestions={suggestions} onClose={() => setSheet(false)} />}
    </>
  )
}

export function RulesSheet({ roundId, suggestions, onClose }: { roundId: string; suggestions: RuleSuggestion[]; onClose: () => void }) {
  const [done, setDone] = React.useState<Set<string>>(new Set())
  const [busy, setBusy] = React.useState<string | null>(null)
  const [failed, setFailed] = React.useState<string | null>(null)

  const remember = async (s: RuleSuggestion) => {
    setBusy(s.suggestion_id); setFailed(null)
    try { await acceptRuleSuggestion(roundId, s.suggestion_id); setDone(d => new Set(d).add(s.suggestion_id)) }
    catch { setFailed(s.suggestion_id) }
    finally { setBusy(null) }
  }

  return (
    <Dialog.Root open onOpenChange={o => { if (!o) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-border bg-bg-elevated p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl sm:bottom-auto sm:top-[15vh] sm:rounded-3xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-lg font-semibold text-text-primary">Remember as rules?</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-text-secondary">These came up in your comments. Remembered rules apply to every future review.</Dialog.Description>
            </div>
            <Dialog.Close aria-label="Close" className="press grid h-11 w-11 shrink-0 place-items-center rounded-full outline-none hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-text-secondary"><X size={18} /></Dialog.Close>
          </div>
          <ul className="mt-4 divide-y divide-border">
            {suggestions.map(s => (
              <li key={s.suggestion_id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-text-primary">{s.text}</p>
                  {failed === s.suggestion_id && <p role="alert" className="mt-1 text-xs text-status-error">Could not save. Try again.</p>}
                </div>
                {done.has(s.suggestion_id)
                  ? <span className="inline-flex min-h-11 shrink-0 items-center gap-1 px-3 text-sm font-medium text-status-success"><Check size={14} aria-hidden="true" />Remembered</span>
                  : <button type="button" disabled={busy === s.suggestion_id} onClick={() => remember(s)} aria-label={`Remember: ${s.text}`}
                      className="press inline-flex h-11 shrink-0 items-center rounded-full bg-accent px-4 text-sm font-semibold text-text-inverse hover:bg-accent-hover disabled:opacity-60">Remember</button>}
              </li>
            ))}
          </ul>
          <button type="button" onClick={onClose} className="press mt-2 min-h-11 w-full rounded-full text-sm font-medium text-text-secondary hover:bg-bg-hover">Done</button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
