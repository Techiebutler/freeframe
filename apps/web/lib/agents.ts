import { api } from './api'

// Contract: docs/superpowers/specs/2026-11-04-agent-review-platform-CONTRACT.md

export type AgentProgram = 'claude-code' | 'codex' | 'chatgpt' | 'cursor' | 'hermes' | 'grok' | 'other'
export type AgentScope = 'read' | 'deliver'

export const PROGRAM_LABEL: Record<AgentProgram, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  chatgpt: 'ChatGPT',
  cursor: 'Cursor',
  hermes: 'Hermes',
  grok: 'Grok',
  other: 'Other',
}

export function programLabel(program: string | null | undefined): string | null {
  if (!program) return null
  return PROGRAM_LABEL[program as AgentProgram] ?? PROGRAM_LABEL.other
}

export interface ProjectAgent {
  user_id: string
  name: string
  program: string
  agent_name: string
  created_at: string
  last_used_at: string | null
  scope?: AgentScope
  revoked: boolean
}
export interface AgentKeyReply { agent_key: string; user_id: string; project_id: string; project_name: string; scope: AgentScope }
export interface PairingCode { code: string; expires_at: string }
export interface RequestAgent { user_id: string; name: string; program: string }

export interface FeedbackV1 {
  schema: 'feedback.v1'
  round_id: string
  request_id: string
  project_id: string
  briefing: string
  opened_at: string
  closed_at: string
  closed_by: 'button' | 'idle'
  files: {
    asset_id: string
    version_id: string
    name: string
    version_number: number
    comments: { comment_id: string; t_start: number | null; t_end: number | null; text: string }[]
  }[]
}
export interface RuleSuggestion { suggestion_id: string; text: string; comment_id: string }

export const MCP_URL = process.env.NEXT_PUBLIC_MCP_URL || 'https://review.aditor.ai/mcp'
export const AGENT_MD_URL = 'https://review.aditor.ai/agent.md'

/** The programs the Agents page offers, in the order people ask for them. */
export const KEY_PROGRAMS: AgentProgram[] = ['claude-code', 'codex', 'chatgpt', 'cursor', 'other']

export const createAgentKey = (projectId: string, program: AgentProgram, scope: AgentScope) =>
  api.post<AgentKeyReply>(`/projects/${projectId}/agent-keys`, { program, agent_name: PROGRAM_LABEL[program], scope })

/** The one block a person pastes into any AI. The playbook at /agent.md does the explaining (spec C). */
export const agentPrompt = (key: string) =>
  `You now have access to AutoReview (video review). First read ${AGENT_MD_URL} and work by it.\n` +
  `API key (Bearer; never print or store it): ${key}\nMCP server: ${MCP_URL}`

/** The extra line for the chosen AI, or null when the prompt is all it needs. */
export function setupLine(program: AgentProgram, key: string): { label: string; text: string } | null {
  if (program === 'claude-code') return { label: 'Or add it in the terminal', text: `claude mcp add --transport http autoreview ${MCP_URL} --header "Authorization: Bearer ${key}"` }
  if (program === 'codex') return null  // ponytail: Codex reads /agent.md and calls the API itself; add an MCP line once its remote-MCP flags settle
  if (program === 'chatgpt' || program === 'cursor') return { label: 'Connector settings', text: `URL: ${MCP_URL}\nHeader: Authorization: Bearer ${key}` }
  return { label: 'Own agent', text: `curl -H "Authorization: Bearer ${key}" -A "AutoReview-Agent/1.0" ${AGENT_MD_URL}` }
}

export const createPairingCode = (projectId: string) =>
  api.post<PairingCode>(`/projects/${projectId}/agent-pairing-codes`)
export const listAgents = (projectId: string) => api.get<ProjectAgent[]>(`/projects/${projectId}/agents`)
export const revokeAgent = (projectId: string, userId: string) => api.delete(`/projects/${projectId}/agents/${userId}`)
export const setAgentsMayApprove = (projectId: string, value: boolean) =>
  api.patch(`/projects/${projectId}`, { agents_may_approve: value })

export const listRequestAgents = (requestId: string) => api.get<RequestAgent[]>(`/requests/${requestId}/agents`)
export const closeRound = (requestId: string) =>
  api.post<FeedbackV1>(`/requests/${requestId}/feedback-rounds/close`, { reason: 'button' })
export const heartbeat = (requestId: string) => api.post(`/requests/${requestId}/heartbeat`)
export const listRuleSuggestions = (roundId: string) =>
  api.get<RuleSuggestion[]>(`/feedback-rounds/${roundId}/rule-suggestions`)
export const acceptRuleSuggestion = (roundId: string, suggestionId: string) =>
  api.post(`/feedback-rounds/${roundId}/rule-suggestions/${suggestionId}/accept`)

export const linkTelegram = () => api.post<{ url: string }>('/me/telegram/link')
export interface DictationSegment { start: number; end: number; text: string }
export interface DictationResult { text: string; segments: DictationSegment[] }
export async function dictate(audio: Blob): Promise<DictationResult> {
  const fd = new FormData()
  fd.append('audio', audio, 'dictation.webm')
  const r = await api.upload<{ text: string; segments?: DictationSegment[] }>('/dictate', fd)
  return { text: r.text, segments: r.segments ?? [] }
}

export function countdown(expiresAt: string, now: number): { label: string; expired: boolean } {
  const left = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000))
  const label = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
  return { label, expired: left === 0 }
}

export const mcpAddCommand = (url: string) => `claude mcp add --transport http autoreview ${url}`
export const pairInstruction = (code: string) => `Pair with code ${code}`
/** What a Claude Code user with the AI Builder Starter Kit types; the kit's autoreview skill does the rest. */
export const kitInstruction = (code: string) => `Pair with AutoReview: ${code}`
export const KIT_URL = 'https://github.com/videoaditor/aditor-kit#install'

export const roundSummary = (round: FeedbackV1) => round.files.reduce((n, f) => n + f.comments.length, 0)
export const formatSent = (agent: string, n: number) => `Sent to ${agent} · ${n} ${n === 1 ? 'comment' : 'comments'}`

export const HEARTBEAT_MS = 60_000

/** The request whose folder holds this asset; live requests win over closed ones. */
export function requestForFolder<T extends { id: string; folder_id?: string | null; state: string }>(requests: T[] | undefined, folderId: string | null | undefined): T | null {
  if (!requests || !folderId) return null
  const hits = requests.filter(r => r.folder_id === folderId)
  return hits.find(r => r.state === 'live') ?? hits[0] ?? null
}

/** Starts a heartbeat that only fires while the tab is visible. Returns the stop function. */
export function startHeartbeat(requestId: string, send: (id: string) => unknown = heartbeat): () => void {
  const tick = () => { if (document.visibilityState === 'visible') void Promise.resolve(send(requestId)).catch(() => {}) }
  const timer = setInterval(tick, HEARTBEAT_MS)
  return () => clearInterval(timer)
}

export const agentNames = (agents: RequestAgent[]) => agents.map(a => a.name).join(', ')
