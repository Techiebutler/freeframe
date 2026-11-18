import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ api: { patch: vi.fn() } }))

/**
 * The Projects page is server-rendered with the default appearance. If the
 * store read this browser's cached appearance as soon as it was created, the
 * first client render would disagree with the server's HTML (a hydration
 * error). It must wait for the page to call persist.rehydrate().
 */
describe('useProjectsViewStore hydration', () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
    window.localStorage.setItem('freeframe-projects-view', JSON.stringify({
      state: { layout: 'list', cardSize: 'L', showCardInfo: false, sortKey: 'name', sortDirection: 'asc' },
      version: 0,
    }))
  })

  it('starts on the defaults, ignoring the cache', async () => {
    const { useProjectsViewStore } = await import('../projects-view-store')

    const { layout, cardSize, sortKey } = useProjectsViewStore.getState()
    expect(layout).toBe('grid')
    expect(cardSize).toBe('M')
    expect(sortKey).toBe('date')
  })

  it('applies the cache once rehydrated', async () => {
    const { useProjectsViewStore } = await import('../projects-view-store')

    await useProjectsViewStore.persist.rehydrate()

    const { layout, cardSize, showCardInfo, sortKey, sortDirection } = useProjectsViewStore.getState()
    expect(layout).toBe('list')
    expect(cardSize).toBe('L')
    expect(showCardInfo).toBe(false)
    expect(sortKey).toBe('name')
    expect(sortDirection).toBe('asc')
  })
})
