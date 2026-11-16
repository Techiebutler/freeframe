import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EmbedChain, chainColumns, chainOrder } from '../embed-chain'

afterEach(cleanup)

const items = [
  { id: 'c', name: 'CTA v1', role: 'cta', order: 0, duration: 4 },
  { id: 'b', name: 'Body v1', role: 'body', order: 0, duration: 24, count: 2 },
  { id: 'h2', name: 'Hook b', role: 'hook', order: 1, duration: 5, count: 3 },
  { id: 'h1', name: 'Hook a', role: 'hook', order: 0, duration: 3 },
]

describe('chain of files', () => {
  it('puts hooks first (stacked, in order), then the body, then the CTA', () => {
    expect(chainColumns(items).map(c => c.map(i => i.id))).toEqual([['h1', 'h2'], ['b'], ['c']])
  })
  it('names a part by its role, numbered only when there are alternatives', () => {
    render(<EmbedChain items={items} selectedId="h2" onSelect={() => {}} />)
    expect(screen.getByRole('button', { name: /Hook 2/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /^Body/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /^CTA/ })).toBeInTheDocument()
  })
  it('selects the part that is clicked', () => {
    const onSelect = vi.fn()
    render(<EmbedChain items={items} selectedId="h1" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: /Hook 2/ }))
    expect(onSelect).toHaveBeenCalledWith('h2')
  })
  it('orders a module folder by role then place; a plain folder has no chain', () => {
    const assets: { id: string; role?: string; order?: number }[] = [{ id: 'x' }, { id: 'c', role: 'cta', order: 0 }, { id: 'h2', role: 'hook', order: 1 }, { id: 'h1', role: 'hook', order: 0 }, { id: 'b', role: 'body', order: 0 }]
    expect(chainOrder(assets)!.map(a => a.id)).toEqual(['h1', 'h2', 'b', 'c', 'x'])
    expect(chainOrder([{ role: null }, {}])).toBeNull()
  })
})
