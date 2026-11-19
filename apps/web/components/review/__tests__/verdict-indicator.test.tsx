import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VerdictIndicator } from '../verdict-indicator'
import { VerdictBadge } from '../verdict-badge'
import type { Verdict, VerdictSummary } from '@/types'

function makeVerdict(partial: Partial<Verdict> & { id: string }): Verdict {
  return {
    version_id: 'v1',
    status: 'approved',
    note: null,
    created_at: '2026-11-18T10:00:00Z',
    updated_at: '2026-11-18T10:00:00Z',
    who: { kind: 'team', name: 'Priya', avatar_url: null, avatar_color: null, is_guest: false },
    via_link_title: null,
    is_mine: false,
    ...partial,
  }
}

const priya = makeVerdict({ id: 'p1', status: 'approved', note: 'Looks great, ship it' })
const dana = makeVerdict({
  id: 'd1',
  status: 'changes_requested',
  note: 'Logo is too small',
  who: { kind: 'external', name: 'Dana', avatar_url: null, avatar_color: null, is_guest: true },
  via_link_title: 'Client review',
})

const realMatchMedia = window.matchMedia
/** The test shim answers false to every query but widths, so a fine pointer is opt-in. */
function usePointer(fine: boolean) {
  const base = window.matchMedia
  window.matchMedia = ((query: string) => {
    if (query.includes('pointer: fine')) return { ...base(query), matches: fine } as MediaQueryList
    return base(query)
  }) as typeof window.matchMedia
}

afterEach(() => {
  window.matchMedia = realMatchMedia
})

function trigger() {
  return screen.getByRole('button', { name: /verdict/i })
}

describe('VerdictIndicator', () => {
  it('renders nothing for an empty list', () => {
    const { container } = render(<VerdictIndicator verdicts={[]} canRemove={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('forgets it was open once the last verdict is gone', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<VerdictIndicator verdicts={[priya]} canRemove={false} />)
    await user.click(trigger())
    expect(screen.getByText('Priya')).toBeInTheDocument()

    rerender(<VerdictIndicator verdicts={[]} canRemove={false} />)
    rerender(<VerdictIndicator verdicts={[priya]} canRemove={false} />)
    expect(screen.queryByText('Priya')).not.toBeInTheDocument()
  })

  it('shows the count and the tone of the most serious verdict', () => {
    render(<VerdictIndicator verdicts={[priya, dana]} canRemove={false} />)
    expect(trigger()).toHaveTextContent('2')
    expect(trigger()).toHaveAttribute('data-tone', 'changes')
  })

  it('lists an external verdict with its name, a Guest tag and the link it came through', async () => {
    const user = userEvent.setup()
    render(<VerdictIndicator verdicts={[priya, dana]} canRemove={false} />)
    await user.click(trigger())

    expect(screen.getByText('Dana')).toBeInTheDocument()
    expect(screen.getByText('Guest')).toBeInTheDocument()
    expect(screen.getByText('via Client review')).toBeInTheDocument()
    expect(screen.getByText('Logo is too small')).toBeInTheDocument()
    // A team member gets neither.
    expect(screen.getByText('Priya')).toBeInTheDocument()
    expect(screen.getAllByText('Guest')).toHaveLength(1)
    expect(screen.getAllByText(/^via /)).toHaveLength(1)
  })

  it('tags a signed-in non-member as a guest too', async () => {
    const user = userEvent.setup()
    const outsider = makeVerdict({
      id: 'o1',
      who: { kind: 'external', name: 'Omar', avatar_url: null, avatar_color: null, is_guest: false },
    })
    render(<VerdictIndicator verdicts={[outsider]} canRemove={false} />)
    await user.click(trigger())
    expect(screen.getByText('Guest')).toBeInTheDocument()
  })

  it('names what each verdict says, not just its colour', async () => {
    const user = userEvent.setup()
    render(<VerdictIndicator verdicts={[priya, dana]} canRemove={false} />)
    await user.click(trigger())
    expect(screen.getByText('Approved')).toBeInTheDocument()
    expect(screen.getByText('Changes needed')).toBeInTheDocument()
  })

  it('has no Remove button without canRemove', async () => {
    const user = userEvent.setup()
    render(<VerdictIndicator verdicts={[priya, dana]} canRemove={false} onRemove={vi.fn()} />)
    await user.click(trigger())
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
  })

  it('asks before removing, then calls onRemove once with the verdict id', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<VerdictIndicator verdicts={[dana]} canRemove onRemove={onRemove} />)
    await user.click(trigger())

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onRemove).not.toHaveBeenCalled()
    expect(screen.getByText('Remove this verdict?')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledWith('d1')
  })

  it('backs out of a removal with Cancel', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<VerdictIndicator verdicts={[dana]} canRemove onRemove={onRemove} />)
    await user.click(trigger())

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onRemove).not.toHaveBeenCalled()
    expect(screen.queryByText('Remove this verdict?')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
  })

  it('confirms the removal of the row it was pressed on, not another', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<VerdictIndicator verdicts={[priya, dana]} canRemove onRemove={onRemove} />)
    await user.click(trigger())

    const danaRow = screen.getByText('Dana').closest('li') as HTMLElement
    await user.click(within(danaRow).getByRole('button', { name: 'Remove' }))
    // The other row still offers plain Remove; this row now holds the prompt.
    expect(within(danaRow).getByText('Remove this verdict?')).toBeInTheDocument()
    await user.click(within(danaRow).getByRole('button', { name: 'Remove' }))

    expect(onRemove).toHaveBeenCalledWith('d1')
  })

  it('closes on Escape and on an outside click', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <button>elsewhere</button>
        <VerdictIndicator verdicts={[priya]} canRemove={false} />
      </div>,
    )

    await user.click(trigger())
    expect(screen.getByText('Priya')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByText('Priya')).not.toBeInTheDocument())

    await user.click(trigger())
    expect(screen.getByText('Priya')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'elsewhere' }))
    await waitFor(() => expect(screen.queryByText('Priya')).not.toBeInTheDocument())
  })

  it('opens from the keyboard', async () => {
    const user = userEvent.setup()
    render(<VerdictIndicator verdicts={[priya]} canRemove={false} />)
    await user.tab()
    expect(trigger()).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByText('Priya')).toBeInTheDocument()
  })

  it('does not open on hover without a fine pointer', async () => {
    usePointer(false)
    const user = userEvent.setup()
    render(<VerdictIndicator verdicts={[priya]} canRemove={false} />)
    await user.hover(trigger())
    expect(screen.queryByText('Priya')).not.toBeInTheDocument()
  })

  it('opens on hover with a fine pointer and closes when the pointer leaves', async () => {
    usePointer(true)
    const user = userEvent.setup()
    render(<VerdictIndicator verdicts={[priya]} canRemove={false} />)

    await user.hover(trigger())
    expect(screen.getByText('Priya')).toBeInTheDocument()

    await user.unhover(trigger())
    await waitFor(() => expect(screen.queryByText('Priya')).not.toBeInTheDocument())
  })

  it('does not hover-open for a touch, even where the primary pointer is a mouse', () => {
    usePointer(true)
    render(<VerdictIndicator verdicts={[priya]} canRemove={false} />)
    fireEvent.pointerEnter(trigger(), { pointerType: 'touch' })
    expect(screen.queryByText('Priya')).not.toBeInTheDocument()
    // The tap that follows still opens it.
    fireEvent.click(trigger())
    expect(screen.getByText('Priya')).toBeInTheDocument()
  })

  it('keeps a hover-opened popover open once it is clicked', async () => {
    usePointer(true)
    const user = userEvent.setup()
    render(<VerdictIndicator verdicts={[priya]} canRemove={false} />)

    // A mouse click is a hover first: it must not open and then shut again.
    await user.click(trigger())
    expect(screen.getByText('Priya')).toBeInTheDocument()

    // Pinned: leaving no longer closes it, and a second click does.
    await user.unhover(trigger())
    await new Promise((r) => setTimeout(r, 300))
    expect(screen.getByText('Priya')).toBeInTheDocument()
    await user.click(trigger())
    await waitFor(() => expect(screen.queryByText('Priya')).not.toBeInTheDocument())
  })

  it('does not drop a pending removal prompt when the pointer leaves', async () => {
    usePointer(true)
    const user = userEvent.setup()
    render(<VerdictIndicator verdicts={[dana]} canRemove onRemove={vi.fn()} />)

    await user.hover(trigger())
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    // The pointer is now on the prompt, which replaced the button it pressed.
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    await user.hover(cancel)
    await user.unhover(cancel)
    await new Promise((r) => setTimeout(r, 300))

    expect(screen.getByText('Remove this verdict?')).toBeInTheDocument()
  })
})

describe('VerdictBadge', () => {
  const summary = (partial: Partial<VerdictSummary>): VerdictSummary => ({
    approved: 0,
    changes_requested: 0,
    rejected: 0,
    ...partial,
  })

  it('shows the count in the tone of the most serious verdict, and names that tone', () => {
    render(<VerdictBadge summary={summary({ approved: 2, rejected: 1 })} />)
    const badge = screen.getByLabelText('3 verdicts, rejected')
    expect(badge).toHaveTextContent('3')
    expect(badge).toHaveAttribute('data-tone', 'rejected')
  })

  it('says verdict in the singular for one', () => {
    render(<VerdictBadge summary={summary({ approved: 1 })} />)
    expect(screen.getByLabelText('1 verdict, approved')).toHaveAttribute('data-tone', 'approved')
  })

  // Colour alone must not be the signal: each tone is named in the label.
  it.each([
    ['rejected', summary({ rejected: 1 }), '1 verdict, rejected'],
    ['changes', summary({ changes_requested: 3 }), '3 verdicts, changes needed'],
    ['approved', summary({ approved: 2 }), '2 verdicts, approved'],
  ])('names the %s tone in its label', (tone, value, label) => {
    render(<VerdictBadge summary={value} />)
    const badge = screen.getByLabelText(label)
    expect(badge).toHaveAttribute('role', 'img')
    expect(badge).toHaveAttribute('title', label)
    expect(badge).toHaveAttribute('data-tone', tone)
  })

  it.each([
    ['no summary', undefined],
    ['a null summary', null],
    ['all zeros', summary({})],
  ])('renders nothing for %s', (_label, value) => {
    const { container } = render(<VerdictBadge summary={value} />)
    expect(container).toBeEmptyDOMElement()
  })
})
