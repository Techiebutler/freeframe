import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { FlowView, type FlowViewProps } from '../flow-view'
import { createOutbox, memoryStore } from '@/lib/outbox'
import { resetSession } from '@/lib/flow-session'

// The request's review link (not the embed) now approves: same action row, "n of m approved", delivery at m of m.
const names = ['Hook 1', 'Hook 2', 'Body', 'CTA']
function setup(over: Partial<FlowViewProps> = {}) {
  const outbox = createOutbox({ store: memoryStore(), send: vi.fn().mockResolvedValue(undefined) as never, isOnline: () => true, wait: async () => {}, onOnline: () => () => {} })
  const props: FlowViewProps = {
    renderMedia: (overlay) => <div data-testid="media">{overlay}</div>,
    files: names.map((name, i) => ({ id: `a${i + 1}`, name })), currentFileId: 'a1', onSelectFile: vi.fn(),
    getPlayhead: () => 3.2, onPause: vi.fn(), onSeek: vi.fn(), canComment: true, canApprove: true,
    notePayload: (n) => ({ kind: 'share', token: 't', assetId: 'a1', ...n }), outbox,
    onApprove: vi.fn().mockResolvedValue(null), onUndoApprove: vi.fn().mockResolvedValue(undefined), approved: false,
    dictate: vi.fn(), ...over,
  }
  const view = render(<FlowView {...props} />)
  return { props, rerender: (o: Partial<FlowViewProps>) => view.rerender(<FlowView {...props} {...o} />) }
}
afterEach(cleanup)
beforeEach(() => resetSession())

describe.each([['phone', {}], ['desktop', { wide: true }]] as const)('FlowView on a review link (%s layout)', (_n, layout) => {
  it('says how many parts are approved, next to the one Approve action', () => {
    setup({ ...layout, parts: { approved: 1, total: 4 } })
    expect(screen.getByTestId('parts-progress')).toHaveTextContent('1 of 4 approved')
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('the last part approved offers the share link; no agent wording anywhere', async () => {
    setup({ ...layout, parts: { approved: 3, total: 4 }, onApprove: vi.fn().mockResolvedValue({ token: 'tok', share_url: 'https://x/d/tok' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByRole('button', { name: 'Copy share link' })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/agent|auto.?review/i)
  })

  it('a link that cannot approve shows no progress row', () => {
    setup({ ...layout, canApprove: false, parts: { approved: 1, total: 4 } })
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })
})
