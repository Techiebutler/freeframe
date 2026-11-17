import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectKanban } from '../project-kanban'
import type { FileRequest } from '@/lib/platform'

const request = (id: string, overrides: Partial<FileRequest> = {}): FileRequest => ({
  id, title: id, token: id, url: `https://example.test/r/${id}`, project_id: 'p1', project_name: 'Northline',
  brief_excerpt: null, last_uploader_name: 'Jamie', assets: 1, state: 'live', status: 'reviewing',
  open_must_fixes: 0, created_at: null, ...overrides,
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('places every request in its actual stage and keeps closed deliveries out of live lanes', () => {
  render(<ProjectKanban requests={[
    request('Waiting', { assets: 0, status: 'clear' }), request('Reviewing'),
    request('Fixing', { status: 'held', open_must_fixes: 2 }), request('Done', { status: 'clear' }),
    request('Closed', { state: 'revoked', status: 'clear' }), request('Expired', { state: 'expired' }),
  ]} paused={false} onShare={vi.fn()} />)
  for (const [stage, title] of [['Agent working', 'Waiting'], ['Checking', 'Reviewing'], ['Agent fixing', 'Fixing'], ['Waiting for you', 'Done']]) {
    expect(within(screen.getByRole('region', { name: stage })).getByRole('link', { name: title })).toBeInTheDocument()
  }
  expect(within(screen.getByRole('region', { name: 'Waiting for you' })).queryByText('Closed')).not.toBeInTheDocument()
  fireEvent.click(screen.getByText('Done', { selector: 'summary span' }))
  expect(screen.getByRole('link', { name: 'Closed' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Share Closed' })).not.toBeInTheDocument()
})

it('shares the selected request and moves it when the backend status changes', () => {
  const onShare = vi.fn()
  const r = request('Morning ritual')
  const view = render(<ProjectKanban requests={[r]} paused={false} onShare={onShare} />)
  fireEvent.click(screen.getByRole('button', { name: 'Share Morning ritual' }))
  expect(onShare).toHaveBeenCalledWith(r)
  view.rerender(<ProjectKanban requests={[{ ...r, status: 'held', open_must_fixes: 3 }]} paused={false} onShare={onShare} />)
  const lane = screen.getByRole('region', { name: 'Agent fixing' })
  expect(within(lane).getByText('3 fixes to make')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('Morning ritual moved to Agent fixing')
  view.rerender(<ProjectKanban requests={[{ ...r, status: 'clear' }]} paused={false} onShare={onShare} />)
  expect(within(screen.getByRole('region', { name: 'Waiting for you' })).getByRole('link', { name: r.title })).toBeInTheDocument()
})

it.each([false, true])('respects paused motion (%s) on real stage changes', paused => {
  const animate = vi.fn(() => ({ cancel: vi.fn() }))
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  const original = HTMLElement.prototype.animate
  HTMLElement.prototype.animate = animate as unknown as typeof original
  const r = request('Morning ritual')
  const view = render(<ProjectKanban requests={[r]} paused={paused} onShare={vi.fn()} />)
  expect(animate).not.toHaveBeenCalled()
  view.rerender(<ProjectKanban requests={[{ ...r, status: 'clear' }]} paused={paused} onShare={vi.fn()} />)
  expect(animate).toHaveBeenCalledTimes(paused ? 0 : 1)
  HTMLElement.prototype.animate = original
  vi.unstubAllGlobals()
})

it('keeps reduced-motion updates instantaneous', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  const animate = vi.fn()
  const original = HTMLElement.prototype.animate
  HTMLElement.prototype.animate = animate
  const r = request('Morning ritual')
  const view = render(<ProjectKanban requests={[r]} paused={false} onShare={vi.fn()} />)
  view.rerender(<ProjectKanban requests={[{ ...r, status: 'clear' }]} paused={false} onShare={vi.fn()} />)
  expect(animate).not.toHaveBeenCalled()
  expect(screen.getByRole('status')).toHaveTextContent('moved to Waiting for you')
  HTMLElement.prototype.animate = original
  vi.unstubAllGlobals()
})

it('puts finished deliveries first and opens their own request in the player', () => {
  render(<ProjectKanban requests={[request('Finished', { status: 'clear', folder_id: 'delivery-3' })]} paused={false} onShare={vi.fn()} />)
  expect(screen.getAllByRole('region').map(region => region.getAttribute('aria-label'))).toEqual([
    'Waiting for you', 'Agent fixing', 'Checking', 'Agent working',
  ])
  expect(screen.getByRole('link', { name: 'Finished' })).toHaveAttribute('href', '/projects/p1/review?folder=delivery-3')
  expect(screen.getByRole('link', { name: 'Review Finished' })).toHaveAttribute('href', '/projects/p1/review?folder=delivery-3')
  expect(screen.getByRole('button', { name: 'Share Finished' })).toBeInTheDocument()
})

it('the ready shortcut shows only ready deliveries, without empty other stages', () => {
  render(<ProjectKanban requests={[request('Finished', { status: 'clear' }), request('Waiting', { assets: 0 })]} paused={false} onShare={vi.fn()} focusReady />)
  expect(screen.getAllByRole('region')).toHaveLength(1)
  expect(screen.getByRole('region', { name: 'Waiting for you' })).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Waiting' })).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Finished' })).toHaveAttribute('href', '/projects/p1/review')
})


it('keeps unavailable files in review with their existing folder and share access', () => {
  render(<ProjectKanban requests={[request('Unavailable', {status:'unavailable',folder_id:'f1'})]} paused={false} onShare={vi.fn()} />)
  expect(screen.getByRole('region', {name:'Checking'})).toHaveTextContent('Review unavailable')
  expect(screen.getByRole('region', {name:'Waiting for you'})).not.toHaveTextContent('Unavailable')
  expect(screen.getByRole('link', {name:'Unavailable'})).toHaveAttribute('href','/projects/p1/review?folder=f1')
  expect(screen.getByRole('button', {name:'Share Unavailable'})).toBeVisible()
})


it('keeps a late briefing failure visible and opens the existing link details for recovery', () => {
  const onShare=vi.fn()
  const pending=request('Launch', {assets:0,checklist_binding_id:'b1',checklist:{id:'b1',status:'queued',requirements:[],limitations:[]}})
  const view=render(<ProjectKanban requests={[pending]} paused={false} onShare={onShare} />)
  expect(screen.queryByRole('button',{name:'Briefing needs attention: Launch'})).not.toBeInTheDocument()
  const failed={...pending,checklist:{...pending.checklist!,status:'failed' as const,error_code:'source-not-authorized'}}
  view.rerender(<ProjectKanban requests={[failed]} paused={false} onShare={onShare} />)
  fireEvent.click(screen.getByRole('button',{name:'Briefing needs attention: Launch'}))
  expect(onShare).toHaveBeenCalledWith(failed)
  expect(screen.getByRole('link',{name:'Launch'})).toHaveAttribute('href','/projects/p1/review')
  expect(screen.getByRole('button',{name:'Share Launch'})).toBeEnabled()
})

it('celebrates, then moves finished projects off the board one by one or all at once', () => {
  vi.useFakeTimers()
  const onDone=vi.fn()
  const a=request('A',{status:'clear'}), b=request('B',{status:'clear'})
  const { container }=render(<ProjectKanban requests={[a,b]} paused={false} onShare={vi.fn()} onDone={onDone} />)
  fireEvent.click(screen.getByRole('button',{name:'Mark A done'}))
  expect(container.querySelector('[data-request-id="A"]')).toHaveAttribute('data-leaving')
  expect(onDone).not.toHaveBeenCalled()
  act(() => { vi.advanceTimersByTime(700) })
  expect(onDone).toHaveBeenLastCalledWith([a])
  fireEvent.click(screen.getByRole('button',{name:'All done'}))
  act(() => { vi.advanceTimersByTime(770) })
  expect(onDone).toHaveBeenLastCalledWith([a,b])
  vi.useRealTimers()
})

it.each(['briefing-unavailable','plan-api-unavailable','review-unconfigured','plan-unavailable'])('stays quiet for the infra failure %s', code => {
  const failed=request('Launch', {assets:0,checklist_binding_id:'b1',checklist:{id:'b1',status:'failed' as const,requirements:[],limitations:[],error_code:code}})
  render(<ProjectKanban requests={[failed]} paused={false} onShare={vi.fn()} />)
  expect(screen.queryByRole('button',{name:'Briefing needs attention: Launch'})).not.toBeInTheDocument()
})

it('puts a self-review card in In review with the agent name and no fix counter, even when held', () => {
  render(<ProjectKanban requests={[request('Agent cut', { status: 'held', open_must_fixes: 4, review_phase: 'self_review', last_uploader_name: 'Hermes Box' })]} paused={false} onShare={vi.fn()} />)
  const lane = screen.getByRole('region', { name: 'Checking' })
  expect(within(lane).getByRole('link', { name: 'Agent cut' })).toBeInTheDocument()
  expect(within(lane).getByText('Self-review · Hermes Box')).toBeInTheDocument()
  expect(screen.queryByText(/fixes to make/)).not.toBeInTheDocument()
})

it('puts an agent-stuck card in Corrections labelled for the owner', () => {
  render(<ProjectKanban requests={[request('Stuck', { status: 'held', open_must_fixes: 2, review_phase: 'agent_stuck' })]} paused={false} onShare={vi.fn()} />)
  const lane = screen.getByRole('region', { name: 'Agent fixing' })
  expect(within(lane).getByText('Agent stuck · needs you')).toBeInTheDocument()
  expect(screen.queryByText(/fixes to make/)).not.toBeInTheDocument()
})

it('leaves ready_for_editor and null phases unchanged', () => {
  render(<ProjectKanban requests={[request('Ready', { status: 'clear', review_phase: 'ready_for_editor' }), request('Human', { status: 'held', open_must_fixes: 1, review_phase: null })]} paused={false} onShare={vi.fn()} />)
  expect(within(screen.getByRole('region', { name: 'Waiting for you' })).getByRole('link', { name: 'Ready' })).toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: 'Agent fixing' })).getByText('1 fix to make')).toBeInTheDocument()
})

// ── Self-managing board ───────────────────────────────────────────────────────
it('maps the four lanes and keeps Done off the board', () => {
  render(<ProjectKanban requests={[
    request('Fresh', { assets: 0 }), request('Fixing', { status: 'held', open_must_fixes: 1 }), request('Check'),
    request('Gate', { status: 'clear' }), request('Stuck', { status: 'clear', review_phase: 'agent_stuck' }),
    request('Approved', { status: 'clear', done_reason: 'approved' }), request('Old', { done_reason: 'stale' }),
  ]} paused={false} onShare={vi.fn()} onDone={vi.fn()} />)
  const lane = (name: string) => within(screen.getByRole('region', { name }))
  expect(lane('Agent working').getByRole('link', { name: 'Fresh' })).toBeInTheDocument()
  expect(lane('Agent fixing').getByRole('link', { name: 'Fixing' })).toBeInTheDocument()
  expect(lane('Agent fixing').getByRole('link', { name: 'Stuck' })).toBeInTheDocument()
  expect(lane('Checking').getByRole('link', { name: 'Check' })).toBeInTheDocument()
  expect(lane('Waiting for you').getByRole('link', { name: 'Gate' })).toBeInTheDocument()
  for (const name of ['Approved', 'Old']) expect(screen.getAllByRole('link', { name }).every(a => !a.closest('[data-lane]'))).toBe(true)
  expect(screen.getByText('Reopens on any new activity')).toBeInTheDocument()
})

it('reopens a stale card as soon as the server stops reporting it Done', () => {
  const stale = request('Revived', { done_reason: 'stale' })
  const { rerender } = render(<ProjectKanban requests={[stale]} paused={false} onShare={vi.fn()} />)
  expect(within(screen.getByRole('region', { name: 'Checking' })).queryByRole('link', { name: 'Revived' })).not.toBeInTheDocument()
  rerender(<ProjectKanban requests={[{ ...stale, done_reason: null }]} paused={false} onShare={vi.fn()} />)
  expect(within(screen.getByRole('region', { name: 'Checking' })).getByRole('link', { name: 'Revived' })).toBeInTheDocument()
})

it('shows the worker, a silent agent, and links back to the Gen Desk card', () => {
  const since = new Date(Date.now() - 30 * 3_600_000).toISOString()
  render(<ProjectKanban requests={[request('Hook 3', {
    assets: 0, worker: { name: 'Jarvis', program: 'Claude Code', kind: 'agent' }, stale_agent: true, agent_silent_since: since, gen_card_key: 'card_9f2',
  })]} paused={false} onShare={vi.fn()} />)
  const card = within(screen.getByRole('region', { name: 'Agent working' }))
  expect(card.getByText('Jarvis · Claude Code')).toBeInTheDocument()
  expect(card.getByRole('status')).toHaveTextContent('Agent silent since 30 h ago')
  expect(card.getByRole('link', { name: /Gen Desk card/ })).toHaveAttribute('href', 'https://gen.aditor.ai/?card=card_9f2#agent-studio')
})

it('shows no Gen link and no silence flag for a plain request', () => {
  render(<ProjectKanban requests={[request('Plain', { assets: 0 })]} paused={false} onShare={vi.fn()} />)
  expect(screen.queryByRole('link', { name: /Gen Desk card/ })).not.toBeInTheDocument()
  expect(screen.queryByText(/Agent silent/)).not.toBeInTheDocument()
})
