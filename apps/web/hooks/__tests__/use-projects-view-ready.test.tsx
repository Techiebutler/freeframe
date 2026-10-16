/**
 * The Projects page draws nothing until the user's appearance is known, so it
 * never paints cards at the defaults and then jumps to their settings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAuthStore } from '@/stores/auth-store'
import { PROJECTS_VIEW_STORAGE_KEY, useProjectsViewStore } from '@/stores/projects-view-store'
import { useProjectsViewReady } from '../use-projects-view-ready'
import { api } from '@/lib/api'
import type { User } from '@/types'

vi.mock('@/lib/api', () => ({ api: { patch: vi.fn() } }))

function user(preferences: Record<string, unknown>): User {
  return {
    id: 'user-1', email: 'test@example.com', name: 'Test User', avatar_url: null,
    status: 'active', is_superadmin: false, email_verified: true, preferences,
    created_at: '2024-01-01T00:00:00Z', deleted_at: null,
  }
}

function cache(state: Record<string, unknown>) {
  window.localStorage.setItem(PROJECTS_VIEW_STORAGE_KEY, JSON.stringify({ state, version: 0 }))
}

describe('useProjectsViewReady', () => {
  beforeEach(() => {
    vi.mocked(api.patch).mockClear()
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false, userFetched: false })
    useProjectsViewStore.setState({
      layout: 'grid', cardSize: 'M', showCardInfo: true, sortKey: 'date', sortDirection: 'desc',
    })
    // After the reset: persist writes every setState through to storage.
    window.localStorage.clear()
  })

  it('is ready on mount with this browser’s cached settings applied', () => {
    cache({ layout: 'grid', cardSize: 'S', showCardInfo: true, sortKey: 'date', sortDirection: 'desc' })

    const { result } = renderHook(() => useProjectsViewReady())

    expect(result.current).toBe(true)
    expect(useProjectsViewStore.getState().cardSize).toBe('S')
    // Loading saved settings is not a change to save.
    expect(api.patch).not.toHaveBeenCalled()
  })

  it('with nothing cached, waits for the account and applies its settings', () => {
    const { result } = renderHook(() => useProjectsViewReady())
    expect(result.current).toBe(false)

    act(() => {
      useAuthStore.setState({
        user: user({ projects_view: { layout: 'list', card_size: 'L' } }),
        isAuthenticated: true,
      })
    })

    expect(result.current).toBe(true)
    expect(useProjectsViewStore.getState().layout).toBe('list')
    expect(useProjectsViewStore.getState().cardSize).toBe('L')
    expect(api.patch).not.toHaveBeenCalled()
  })

  it('with nothing cached or saved, becomes ready on the defaults', () => {
    const { result } = renderHook(() => useProjectsViewReady())

    act(() => {
      useAuthStore.setState({ user: user({}), isAuthenticated: true })
    })

    expect(result.current).toBe(true)
    expect(useProjectsViewStore.getState().cardSize).toBe('M')
  })

  it('with nothing cached, falls back to the defaults if the account fails to load', () => {
    const { result } = renderHook(() => useProjectsViewReady())

    act(() => { useAuthStore.setState({ isLoading: true }) })
    expect(result.current).toBe(false)

    act(() => { useAuthStore.setState({ isLoading: false, userFetched: true }) })
    expect(result.current).toBe(true)
    expect(useProjectsViewStore.getState().cardSize).toBe('M')
  })

  it('with nothing cached, does not wait for an account that failed before the page mounted', () => {
    useAuthStore.setState({ user: null, isLoading: false, userFetched: true })

    const { result } = renderHook(() => useProjectsViewReady())

    expect(result.current).toBe(true)
    expect(useProjectsViewStore.getState().cardSize).toBe('M')
  })

  it('with nothing cached, still waits when the fetch has not started yet', () => {
    // How a first load looks at mount: the layout's fetch effect runs after
    // the page's, so the store is not loading and has no user yet.
    const { result } = renderHook(() => useProjectsViewReady())

    expect(result.current).toBe(false)
  })

  it('lets the account replace a stale cached value', () => {
    cache({ layout: 'grid', cardSize: 'S', showCardInfo: true, sortKey: 'date', sortDirection: 'desc' })
    renderHook(() => useProjectsViewReady())

    act(() => {
      useAuthStore.setState({
        user: user({ projects_view: { layout: 'grid', card_size: 'L' } }),
        isAuthenticated: true,
      })
    })

    expect(useProjectsViewStore.getState().cardSize).toBe('L')
  })
})
