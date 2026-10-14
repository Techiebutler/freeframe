import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useProjectsViewStore } from '../projects-view-store'
import { useAuthStore } from '../auth-store'
import type { User } from '@/types'

vi.mock('@/lib/api', () => ({
  api: {
    patch: vi.fn(),
  },
}))

import { api } from '@/lib/api'

const mockUser: User = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  avatar_url: null,
  status: 'active',
  is_superadmin: false,
  email_verified: true,
  preferences: { theme: 'light' },
  created_at: '2024-01-01T00:00:00Z',
  deleted_at: null,
}

describe('useProjectsViewStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.patch).mockResolvedValue(undefined)
    useProjectsViewStore.setState({
      layout: 'grid', cardSize: 'M', showCardInfo: true, sortKey: 'date', sortDirection: 'desc',
    })
    useAuthStore.setState({ user: { ...mockUser }, isAuthenticated: true })
  })

  // Saves go out one at a time; let any still in flight settle so the next
  // test's first save isn't queued behind this one's.
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })

  it('defaults to a medium grid with card info', () => {
    const { layout, cardSize, showCardInfo } = useProjectsViewStore.getState()
    expect(layout).toBe('grid')
    expect(cardSize).toBe('M')
    expect(showCardInfo).toBe(true)
    expect(useProjectsViewStore.getState().sortKey).toBe('date')
    expect(useProjectsViewStore.getState().sortDirection).toBe('desc')
  })

  it('setSortKey and toggleSortDirection save the sort to the account', async () => {
    useProjectsViewStore.getState().setSortKey('name')
    useProjectsViewStore.getState().toggleSortDirection()

    const { sortKey, sortDirection } = useProjectsViewStore.getState()
    expect(sortKey).toBe('name')
    expect(sortDirection).toBe('desc')
    await vi.waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2))
    expect(api.patch).toHaveBeenLastCalledWith('/auth/me/preferences', {
      projects_view: {
        layout: 'grid', card_size: 'M', show_card_info: true, sort_key: 'name', sort_direction: 'desc',
      },
    })
  })

  it('picking a sort starts it in its natural direction', () => {
    // Newest-first by date; switching to name must not carry that over as Z-A.
    useProjectsViewStore.getState().setSortKey('name')
    expect(useProjectsViewStore.getState().sortDirection).toBe('asc')

    useProjectsViewStore.getState().setSortKey('date')
    expect(useProjectsViewStore.getState().sortDirection).toBe('desc')
  })

  it('syncFromServer applies a saved sort and ignores an invalid one', () => {
    useProjectsViewStore.getState().syncFromServer({
      projects_view: { layout: 'grid', card_size: 'M', sort_key: 'name', sort_direction: 'asc' },
    })
    expect(useProjectsViewStore.getState().sortKey).toBe('name')
    expect(useProjectsViewStore.getState().sortDirection).toBe('asc')

    useProjectsViewStore.getState().syncFromServer({
      projects_view: { layout: 'grid', card_size: 'M', sort_key: 'status', sort_direction: 'up' },
    })
    expect(useProjectsViewStore.getState().sortKey).toBe('date')
    expect(useProjectsViewStore.getState().sortDirection).toBe('desc')
  })

  it('sends one save at a time, then only the latest change', async () => {
    // The endpoint read-modify-writes the whole preferences document, so two
    // PATCHes in flight could land out of order and store the older value.
    let finishFirst!: () => void
    vi.mocked(api.patch).mockImplementationOnce(
      () => new Promise((resolve) => { finishFirst = () => resolve(undefined) }),
    )

    const store = useProjectsViewStore.getState()
    store.setLayout('list')
    store.setCardSize('S')
    store.setCardSize('L')

    expect(api.patch).toHaveBeenCalledTimes(1)
    finishFirst()
    await vi.waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2))

    const sent = vi.mocked(api.patch).mock.calls.map((c) => (c[1] as { projects_view: { card_size: string } }).projects_view.card_size)
    expect(sent).toEqual(['M', 'L'])
  })

  it('still sends the queued change when a save fails', async () => {
    vi.mocked(api.patch).mockRejectedValueOnce(new Error('500'))

    useProjectsViewStore.getState().setLayout('list')
    useProjectsViewStore.getState().setCardSize('L')

    await vi.waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2))
    expect(api.patch).toHaveBeenLastCalledWith('/auth/me/preferences', {
      projects_view: expect.objectContaining({ layout: 'list', card_size: 'L' }),
    })
  })

  it('setLayout saves the full projects_view to the account', async () => {
    useProjectsViewStore.getState().setCardSize('L')
    await new Promise((r) => setTimeout(r, 0)) // let that save settle
    vi.mocked(api.patch).mockClear()

    useProjectsViewStore.getState().setLayout('list')

    expect(useProjectsViewStore.getState().layout).toBe('list')
    expect(api.patch).toHaveBeenCalledWith('/auth/me/preferences', {
      projects_view: { layout: 'list', card_size: 'L', show_card_info: true, sort_key: 'date', sort_direction: 'desc' },
    })
  })

  it('setShowCardInfo saves the full projects_view to the account', () => {
    useProjectsViewStore.getState().setShowCardInfo(false)

    expect(useProjectsViewStore.getState().showCardInfo).toBe(false)
    expect(api.patch).toHaveBeenCalledWith('/auth/me/preferences', {
      projects_view: { layout: 'grid', card_size: 'M', show_card_info: false, sort_key: 'date', sort_direction: 'desc' },
    })
  })

  it('updates the cached user preferences, keeping other keys', () => {
    useProjectsViewStore.getState().setCardSize('S')

    expect(useAuthStore.getState().user?.preferences).toEqual({
      theme: 'light',
      projects_view: { layout: 'grid', card_size: 'S', show_card_info: true, sort_key: 'date', sort_direction: 'desc' },
    })
  })

  it('does not call the API when signed out', () => {
    useAuthStore.setState({ user: null, isAuthenticated: false })

    useProjectsViewStore.getState().setLayout('list')

    expect(useProjectsViewStore.getState().layout).toBe('list')
    expect(api.patch).not.toHaveBeenCalled()
  })

  it('syncFromServer applies a valid saved value', () => {
    useProjectsViewStore.getState().syncFromServer({
      projects_view: { layout: 'list', card_size: 'S', show_card_info: false },
    })

    const { layout, cardSize, showCardInfo } = useProjectsViewStore.getState()
    expect(layout).toBe('list')
    expect(cardSize).toBe('S')
    expect(showCardInfo).toBe(false)
  })

  it('syncFromServer treats a value saved before the card info toggle as on', () => {
    useProjectsViewStore.setState({ showCardInfo: false })

    useProjectsViewStore.getState().syncFromServer({
      projects_view: { layout: 'grid', card_size: 'L' },
    })

    expect(useProjectsViewStore.getState().showCardInfo).toBe(true)
  })

  it('syncFromServer resets to defaults when the account has nothing saved', () => {
    useProjectsViewStore.setState({
      layout: 'list', cardSize: 'L', showCardInfo: false, sortKey: 'name', sortDirection: 'asc',
    })

    useProjectsViewStore.getState().syncFromServer({ theme: 'dark' })

    const { layout, cardSize } = useProjectsViewStore.getState()
    expect(layout).toBe('grid')
    expect(cardSize).toBe('M')
  })

  it('syncFromServer ignores invalid saved values', () => {
    useProjectsViewStore.setState({
      layout: 'list', cardSize: 'L', showCardInfo: false, sortKey: 'name', sortDirection: 'asc',
    })

    useProjectsViewStore.getState().syncFromServer({
      projects_view: { layout: 'carousel', card_size: 'XL' },
    })

    const { layout, cardSize } = useProjectsViewStore.getState()
    expect(layout).toBe('grid')
    expect(cardSize).toBe('M')
  })
})
