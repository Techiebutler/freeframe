import { describe, it, expect, beforeEach } from 'vitest'
import { useViewStore } from '../view-store'

describe('useViewStore sort', () => {
  beforeEach(() => {
    useViewStore.setState({ sortKey: 'date', sortDirection: 'desc' })
  })

  it('picking a sort starts it in its natural direction', () => {
    // Newest-first by date; switching to name must not carry that over as Z-A.
    useViewStore.getState().setSortKey('name')
    expect(useViewStore.getState().sortDirection).toBe('asc')

    useViewStore.getState().setSortKey('date')
    expect(useViewStore.getState().sortDirection).toBe('desc')
  })

  it('toggleSortDirection still flips the active sort', () => {
    useViewStore.getState().toggleSortDirection()
    expect(useViewStore.getState().sortDirection).toBe('asc')
  })
})
