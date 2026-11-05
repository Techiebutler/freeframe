'use client'

import * as React from 'react'
import Link from 'next/link'
import { CheckCheck, FileVideo, PencilLine, ScanLine, Share2, Upload } from 'lucide-react'
import type { FileRequest } from '@/lib/platform'
import { FolderArt } from './folder-art'

const STAGES = [
  { id: 'ready', label: 'Ready to go', icon: CheckCheck },
  { id: 'corrections', label: 'Corrections', icon: PencilLine },
  { id: 'review', label: 'In review', icon: ScanLine },
  { id: 'editor', label: 'With editor', icon: Upload },
] as const
type Stage = typeof STAGES[number]['id']

function stageOf(r: FileRequest): Stage | 'closed' {
  if (r.state !== 'live') return 'closed'
  if (r.review_phase === 'self_review') return 'review'
  if (r.review_phase === 'agent_stuck') return 'corrections'
  if (!r.assets) return 'editor'
  if (r.status === 'reviewing' || r.status === 'unavailable') return 'review'
  return r.status === 'held' ? 'corrections' : 'ready'
}

// Only failures the owner can fix; infra codes (briefing-unavailable, plan-api-unavailable, ...) stay quiet.
const OWNER_ACTIONABLE = new Set(['source-not-authorized', 'card-unavailable', 'plan-failed', 'snapshot-identity-invalid'])

type Position = { x: number; y: number; stage: string; width: number }

export function ProjectKanban({ requests, paused, onShare, onDone, focusReady = false }: {
  requests: FileRequest[]
  paused: boolean
  onShare: (request: FileRequest) => void
  /** Moves finished projects off the board into "Done". */
  onDone?: (requests: FileRequest[]) => void
  focusReady?: boolean
}) {
  const board = React.useRef<HTMLDivElement>(null)
  const positions = React.useRef(new Map<string, Position>())
  const animations = React.useRef<Animation[]>([])
  const [announcement, setAnnouncement] = React.useState('')
  const closed = requests.filter(r => r.state !== 'live')
  // Done is a small celebration: the cards glow, burst and lift away, then leave the board
  const [leaving, setLeaving] = React.useState<Map<string, number>>(new Map())
  const finish = (items: FileRequest[]) => {
    if (!onDone || items.some(r => leaving.has(r.id))) return
    const reduced = paused || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    setLeaving(new Map(items.map((r, i) => [r.id, Math.min(i, 8)])))
    setAnnouncement(items.length === 1 ? `${items[0].title} done` : `${items.length} projects done`)
    window.setTimeout(() => { onDone(items); setLeaving(new Map()) }, reduced ? 200 : DONE_MS + STAGGER_MS * Math.min(items.length - 1, 8))
  }

  React.useLayoutEffect(() => {
    const root = board.current
    if (!root) return
    animations.current.forEach(a => a.cancel())
    animations.current = []
    const bounds = root.getBoundingClientRect()
    const next = new Map<string, Position>()
    const changes: string[] = []
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    root.querySelectorAll<HTMLElement>('[data-request-id]').forEach(card => {
      const id = card.dataset.requestId!
      const rect = card.getBoundingClientRect()
      const position = { x: rect.left - bounds.left + root.scrollLeft, y: rect.top - bounds.top, stage: card.dataset.stage!, width: bounds.width }
      const before = positions.current.get(id)
      next.set(id, position)
      if (!before || (before.stage === position.stage && before.x === position.x && before.y === position.y)) return
      // Same lane: the cards below a finished one close the gap instead of jumping up
      if (before.stage !== position.stage) changes.push(`${requests.find(r => r.id === id)!.title} moved to ${STAGES.find(s => s.id === position.stage)!.label}`)
      if (!paused && !reduced && card.animate) {
        // Coordinates are relative to the board so page/board scrolling cannot create false travel.
        const sameWidth = before.width === position.width
        animations.current.push(card.animate([
          { transform: `translate(${sameWidth ? before.x - position.x : 0}px, ${sameWidth ? before.y - position.y : 0}px)`, opacity: 0.72 },
          { transform: 'translate(0, 0)', opacity: 1 },
        ], { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }))
      }
    })
    positions.current = next
    if (changes.length) setAnnouncement(changes.join('. '))
  }, [requests, paused])

  React.useEffect(() => () => animations.current.forEach(a => a.cancel()), [])
  React.useEffect(() => {
    if (focusReady) board.current?.querySelector('[data-lane="ready"]')?.scrollIntoView?.({ block: 'nearest', inline: 'start' })
  }, [focusReady])

  return <div className="project-kanban" data-paused={paused} data-focus-ready={focusReady}>
    <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
    <div ref={board} className="kanban-scroll" role="group" aria-label="Project stages" tabIndex={0}>
      {STAGES.filter(stage => !focusReady || stage.id === 'ready').map(({ id, label, icon: Icon }) => {
        const items = requests.filter(r => stageOf(r) === id)
        return <section key={id} aria-label={label} className="kanban-lane" data-lane={id}>
          <div className="kanban-lane-heading"><span className="kanban-stage-icon"><Icon size={17} /></span><h3>{label}</h3><span className="kanban-count">{items.length}</span>{id === 'ready' && onDone && items.length > 1 && <button type="button" onClick={() => finish(items)} className="press ml-auto min-h-11 px-2 text-[0.75rem] font-medium text-text-secondary hover:text-text-primary">All done</button>}</div>
          <ul aria-label={`${label} projects`} className="kanban-cards">
            {items.map(r => <ProjectCard key={r.id} request={r} stage={id} onShare={() => onShare(r)} onDone={onDone && (() => finish([r]))} leaving={leaving.get(r.id)} />)}
          </ul>
          {!items.length && <p className="kanban-empty">No projects here</p>}
        </section>
      })}
    </div>
    <p className="mt-3 text-sm text-text-secondary">Ready to go means the current videos passed review with no required changes. Brand approval is a separate decision in FreeFrame.</p>
    {!!closed.length && <details className="mt-4 rounded-2xl border border-border px-4">
      <summary className="min-h-11 cursor-pointer py-3 text-[0.8125rem] text-text-secondary"><span>Done</span> <span key={closed.length} className="kanban-done-count ml-1">{closed.length}</span></summary>
      <ul className="grid gap-3 pb-4 sm:grid-cols-2 lg:grid-cols-4">{closed.map(r => <ProjectCard key={r.id} request={r} stage="closed" onShare={() => onShare(r)} />)}</ul>
    </details>}
  </div>
}

/** Opening a project goes straight to its player, never to the file manager. */
export const reviewHref = (r: FileRequest) => `/projects/${r.project_id}/review${r.folder_id ? `?folder=${encodeURIComponent(r.folder_id)}` : ''}`

const DONE_MS = 700
const STAGGER_MS = 70

function ProjectCard({ request: r, stage, onShare, onDone, leaving }: { request: FileRequest; stage: Stage | 'closed'; onShare: () => void; onDone?: () => void; leaving?: number }) {
  const label = r.state === 'live' && r.review_phase === 'self_review' ? `Self-review · ${r.last_uploader_name || 'agent'}` : r.state === 'live' && r.review_phase === 'agent_stuck' ? 'Agent stuck · needs you' : r.status === 'unavailable' ? 'Review unavailable' : stage === 'editor' ? 'Waiting for files' : stage === 'review' ? 'Reviewing files' : stage === 'corrections' ? r.open_must_fixes > 0 ? `${r.open_must_fixes} ${r.open_must_fixes === 1 ? 'fix' : 'fixes'} to make` : 'With editor for updates' : stage === 'ready' ? 'Ready to go' : r.state === 'revoked' ? 'Closed' : 'Expired'
  return <li className="kanban-card" data-request-id={r.id} data-stage={stage} data-leaving={leaving !== undefined || undefined} style={leaving !== undefined ? { '--i': leaving } as React.CSSProperties : undefined}>
    <div className="flex items-start justify-between gap-2">
      <div className="kanban-art" aria-hidden="true"><FolderArt size={36} label="" />{stage === 'review' && <span className="kanban-scan" />}{stage === 'corrections' && <PencilLine className="kanban-pencil" size={19} />}{stage === 'ready' && <span className="kanban-check"><CheckCheck size={13} /></span>}</div>
      {r.state === 'live' && <button type="button" onClick={onShare} aria-label={`Share ${r.title}`} className="press kanban-share"><Share2 size={15} /></button>}
    </div>
    <Link href={reviewHref(r)} className="kanban-title">{r.title}</Link>
    <p className="kanban-brand">{r.project_name}</p>
    <div className="kanban-card-status"><span className="kanban-status-dot" aria-hidden="true" />{leaving !== undefined ? 'Done' : label}</div>
    {r.state === 'live' && r.checklist?.status === 'failed' && OWNER_ACTIONABLE.has(r.checklist.error_code ?? '') && <button type="button" onClick={onShare} aria-label={`Briefing needs attention: ${r.title}`} className="press mt-2 min-h-11 text-left text-sm font-medium text-status-error underline underline-offset-4">Briefing needs attention</button>}
    {stage === 'ready' && <div className="mt-3 flex gap-2"><Link href={reviewHref(r)} aria-label={`Review ${r.title}`} className="press flex min-h-11 flex-1 items-center justify-center rounded-full border border-border text-[0.8125rem] font-medium hover:bg-bg-hover">Review</Link>{onDone && <button type="button" onClick={onDone} aria-label={`Mark ${r.title} done`} className="press kanban-done flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-accent-muted text-[0.8125rem] font-medium text-accent"><span className="kanban-done-icon"><CheckCheck size={14} /></span>Done<span className="kanban-burst" aria-hidden="true">{Array.from({ length: 10 }, (_, i) => <span key={i} style={{ '--a': `${i * 36}deg` } as React.CSSProperties} />)}</span></button>}</div>}
    <div className="kanban-card-footer"><span className="inline-flex items-center gap-1.5"><FileVideo size={13} />{r.assets} {r.assets === 1 ? 'file' : 'files'}</span>{r.last_uploader_name && <span className="kanban-editor" title={r.last_uploader_name}><span aria-hidden="true" className="kanban-avatar">{r.last_uploader_name.charAt(0)}</span><span>{r.last_uploader_name}</span></span>}</div>
  </li>
}
