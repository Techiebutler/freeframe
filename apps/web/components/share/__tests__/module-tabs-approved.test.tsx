import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ModuleTabs } from '../module-tabs'

describe('ModuleTabs approved mark', () => {
  it('shows a check only on approved parts', () => {
    render(<ModuleTabs nav items={[{ id: 'a', name: 'Hook 1', approved: true }, { id: 'b', name: 'Hook 2' }, { id: 'c', name: 'Body' }]} selectedId="b" onSelect={() => {}} />)
    expect(screen.getAllByLabelText('approved')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /Hook 1/ })).toContainElement(screen.getByLabelText('approved'))
  })
})
