import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EmbedChain, EmbedTabs, chainColumns, chainOrder, inferRoles, moduleRoleOf } from '../embed-chain'

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

describe('modules recognised from file names', () => {
  const names = ['EN_Hook1_WithoutTwoThings', 'EN_Hook2_Millionaire', 'EN_Hook3_YourAgent', 'EN_Body', 'EN_CTA']
  it('reads hook / body / cta, with their place, from names that carry a descriptor', () => {
    expect(names.map(n => moduleRoleOf(n))).toEqual([
      { role: 'hook', order: 0 }, { role: 'hook', order: 1 }, { role: 'hook', order: 2 }, { role: 'body', order: 0 }, { role: 'cta', order: 0 }])
  })
  it('reads hook letters and extensions; a whole ad (hook1_full) is no module', () => {
    expect(moduleRoleOf('EN-hook-a')).toEqual({ role: 'hook', order: 0 })
    expect(moduleRoleOf('DE-hook-c.mp4')).toEqual({ role: 'hook', order: 2 })
    expect(moduleRoleOf('hook1_full')).toBeUndefined()
    expect(moduleRoleOf('Ad final v3')).toBeUndefined()
  })
  it('gives assets without a server role one from their names, in chain order', () => {
    const assets: { id: string; name: string; role?: string; order?: number }[] = names.map((name, i) => ({ id: String(i), name }))
    const out = inferRoles([assets[4], assets[3], assets[2], assets[0], assets[1]])
    expect(chainOrder(out)!.map(a => a.name)).toEqual(['EN_Hook1_WithoutTwoThings', 'EN_Hook2_Millionaire', 'EN_Hook3_YourAgent', 'EN_Body', 'EN_CTA'])
    expect(out.filter(a => a.role === 'hook').map(a => a.order).sort()).toEqual([0, 1, 2])
  })
  it('leaves plain files and server roles alone', () => {
    const plain = [{ id: 'a', name: 'cut v2' }, { id: 'b', name: 'cut v3' }]
    expect(inferRoles(plain)).toBe(plain)
    const served = [{ id: 'a', name: 'EN_Hook1_X', role: 'body', order: 0 }]
    expect(inferRoles(served)).toBe(served)
  })
  it('plain files show as named tabs, the current one pressed, no pager', () => {
    const onSelect = vi.fn()
    render(<EmbedTabs items={[{ id: 'a', name: 'cut v2.mp4' }, { id: 'b', name: 'cut v3.mp4' }]} selectedId="b" onSelect={onSelect} />)
    expect(screen.getByRole('button', { name: 'cut v3' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'cut v2' }))
    expect(onSelect).toHaveBeenCalledWith('a')
  })
})
