import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import HomePage from '../page'
import type { EditorStats } from '@/lib/platform'

const state = vi.hoisted(() => ({ error: undefined as Error | undefined, reviewed: true, editors: [] as EditorStats[], requests: [
  { id: '1', title: 'Launch cut', project_id: 'p', project_name: 'Studio', state: 'live', assets: 1, status: 'clear', review_share_token: 'delivery-1', url: 'https://example.test/r/1', open_must_fixes: 0 },
  { id: '2', title: 'Summer cut', project_id: 'p', project_name: 'Studio', state: 'live', assets: 2, status: 'held', url: 'https://example.test/r/2', open_must_fixes: 2 },
  { id: '3', title: 'Closed campaign', project_id: 'p', project_name: 'Studio', state: 'revoked', assets: 1, status: 'clear', url: 'https://example.test/r/3', open_must_fixes: 0 },
] }));
vi.mock('swr', () => ({ default: (key: string) => key === '/requests' ? { data: state.error ? undefined : state.requests, error: state.error, mutate: vi.fn() } : { data: key === '/insights/editors' ? { reviewed: state.reviewed, editors: state.editors } : undefined } }))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: vi.fn() }))
vi.mock('@/components/v2/request-sheet', () => ({ RequestSheet: () => null }))
afterEach(cleanup)
beforeEach(() => { state.error = undefined; state.reviewed = true; state.editors = [] })

it('filters ready deliveries and searches without including closed requests in the ready count', () => {
  render(<HomePage />)
  fireEvent.click(screen.getByRole('button', { name: 'Show ready requests' }))
  expect(screen.getByRole('link', { name: 'Launch cut' })).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Closed campaign' })).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search requests' }), { target: { value: 'nothing' } })
  expect(screen.getByText('No matching requests')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
  expect(screen.getByRole('link', { name: 'Summer cut' })).toBeInTheDocument()
})
it('shows retry rather than a false empty account when requests fail', () => {
  state.error = new Error('offline')
  render(<HomePage />)
  expect(screen.getByRole('alert')).toHaveTextContent('Could not load requests')
  expect(screen.queryByText('Request your first files')).not.toBeInTheDocument()
})
it('shares the backend download link instead of upload-link access and closes the share dialog with Escape', () => {
  render(<HomePage />)
  fireEvent.click(screen.getByRole('button', { name: 'Share Launch cut' }))
  expect(screen.getByRole('dialog')).toHaveTextContent('Anyone with this link can view and download these files.')
  expect(screen.getByRole('link', { name: 'Preview shared files' })).toHaveAttribute('href', `${window.location.origin}/share/delivery-1`)
  expect(screen.queryByRole('link', { name: 'Open upload page' })).not.toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('distinguishes unavailable review data from having no reviewed videos', () => {
  state.reviewed = false
  render(<HomePage />)
  expect(screen.getByRole('alert')).toHaveTextContent('Editor results unavailable')
  expect(screen.queryByText('No reviewed first versions yet')).not.toBeInTheDocument()
})

it('keeps API ranking, exposes partial samples and distinguishes zero from unknown accuracy', () => {
  state.editors = [
    { email: 'z@example.test', name: 'Zoe', videos: 8, rated: 2, first_try_rate: 1, avg_versions: 1.25, open_must_fixes: 3 },
    { email: 'a@example.test', name: 'Alex', videos: 30, rated: 30, first_try_rate: 0, avg_versions: 2, open_must_fixes: 0 },
    { email: 'n@example.test', name: 'New editor', videos: 1, rated: 0, first_try_rate: null, avg_versions: null, open_must_fixes: 0 },
  ]
  render(<HomePage />)
  const list = screen.getByRole('list', { name: 'Editor accuracy ranking' })
  const rows = within(list).getAllByRole('listitem')
  expect(rows[0]).toHaveTextContent('Zoe')
  expect(rows[0]).toHaveTextContent('100%')
  expect(rows[0]).toHaveTextContent('2 of 8 reviewed')
  expect(rows[0]).toHaveTextContent('Small sample')
  expect(rows[0]).toHaveTextContent('1.3')
  expect(rows[0]).toHaveTextContent('3 open must-fixes')
  expect(rows[1]).toHaveTextContent('0%')
  expect(rows[2]).toHaveTextContent('Not reviewed yet')
  expect(rows[2]).not.toHaveTextContent('0%')
  expect(rows[2]).not.toHaveTextContent('Small sample')
})

it('shows one editor average with a notification count and identifies both outlier directions', () => {
  state.editors = [1, .6, .2].map((rate, i) => ({ email: `editor${i}@example.test`, name: `Editor ${i}`, videos: 10, rated: 10, first_try_rate: rate, avg_versions: 1, open_must_fixes: 0 }))
  render(<HomePage />)
  const metric = screen.getByRole('link', { name: /First-try pass rate/ })
  expect(metric).toHaveTextContent('60%')
  expect(metric).not.toHaveTextContent('20–100%')
  expect(within(metric).getByLabelText('2 editors stand out. See ranking.')).toHaveTextContent('2')
  expect(metric).toHaveAttribute('href', '#editor-performance')
  const rows = within(screen.getByRole('list', { name: 'Editor accuracy ranking' })).getAllByRole('listitem')
  expect(rows[0]).toHaveTextContent('Above average')
  expect(rows[1]).not.toHaveTextContent('Above average')
  expect(rows[2]).toHaveTextContent('Below average')
})
it('hides outlier notifications when review data is unavailable', () => {
  state.reviewed = false
  state.editors = [1, .6, .2].map((rate, i) => ({ email: `${i}@example.test`, name: `${i}`, videos: 10, rated: 10, first_try_rate: rate, avg_versions: 1, open_must_fixes: 0 }))
  render(<HomePage />)
  expect(screen.queryByLabelText(/editors stand out/)).not.toBeInTheDocument()
})


it('uses one compact disclosure per editor and keeps extra metrics inside it', () => {
  state.editors = [{ email: 'robin@example.test', name: 'Robin', videos: 24, rated: 24, first_try_rate: .92, avg_versions: 1.1, open_must_fixes: 0 }]
  render(<HomePage />)
  const row = within(screen.getByRole('list', { name: 'Editor accuracy ranking' })).getByRole('listitem')
  const summary = row.querySelector('summary')!
  expect(summary).toHaveTextContent('Robin')
  expect(summary).toHaveTextContent('92%')
  expect(summary).not.toHaveTextContent('versions per video')
  expect(row.querySelector('details')).not.toHaveAttribute('open')
  expect(row).toHaveTextContent('1.1 versions per video')
  expect(screen.getByRole('button', { name: 'Invite via file request' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /Brand guidelines/ })).toHaveAttribute('href', '/rules')
})

it('does not fall back to an upload link when a delivery token is missing', () => {
  render(<HomePage />)
  fireEvent.click(screen.getByRole('button', { name: 'Share Summer cut' }))
  expect(screen.getByRole('dialog')).toHaveTextContent('file-sharing link is unavailable')
  expect(screen.queryByRole('link', { name: 'Open upload page' })).not.toBeInTheDocument()
})

it('badges agents in the ranking with their program and leaves humans unbadged', () => {
  state.editors = [
    { email: 'agent+1@agents.autoreview.local', name: 'Hermes Box (hermes)', videos: 4, rated: 4, first_try_rate: 1, avg_versions: 1, open_must_fixes: 0, kind: 'agent', program: 'claude-code' },
    { email: 'h@example.test', name: 'Hana', videos: 4, rated: 4, first_try_rate: 0.5, avg_versions: 1, open_must_fixes: 0, kind: 'human', program: null },
  ]
  render(<HomePage />)
  const rows = within(screen.getByRole('list', { name: 'Editor accuracy ranking' })).getAllByRole('listitem')
  expect(rows[0]).toHaveTextContent('Claude Code')
  expect(rows[0]).not.toHaveTextContent('agents.autoreview.local')
  expect(rows[1]).not.toHaveTextContent('Claude Code')
})
