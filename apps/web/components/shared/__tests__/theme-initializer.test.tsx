/**
 * A page load keeps the theme saved in this browser (#661).
 *
 * The store reads localStorage as it is created, but a hydrating component is
 * given the store's initial state first, which is dark. The initializer applied
 * that on mount and so saved dark over the stored choice. Signed-in users got
 * theirs back from the server; on /login, /setup and share pages it was gone.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { hydrateRoot } from 'react-dom/client'

const KEY = 'ff-theme'
const saved = () => JSON.parse(window.localStorage.getItem(KEY) ?? 'null')?.state?.theme
const shown = () => document.documentElement.getAttribute('data-theme')

/** Load the page as a browser does: server HTML, then hydration over it. */
async function loadPage(stored: string | null) {
  vi.resetModules()
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  if (stored !== null) window.localStorage.setItem(KEY, stored)
  const { ThemeInitializer } = await import('../theme-initializer')
  const { useThemeStore } = await import('@/stores/theme-store')
  const { useAuthStore } = await import('@/stores/auth-store')
  const container = document.createElement('div')
  container.innerHTML = renderToString(<ThemeInitializer />)
  const root = await act(async () => hydrateRoot(container, <ThemeInitializer />))
  return { useThemeStore, useAuthStore, unmount: () => act(async () => root.unmount()) }
}

const state = (theme: string) => JSON.stringify({ state: { theme }, version: 0 })

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('dark') ? false : true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})

describe('loading a page signed out', () => {
  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', 'light'], // the OS is light here
  ])('keeps a saved %s theme', async (theme, painted) => {
    const { useThemeStore, unmount } = await loadPage(state(theme))

    expect(saved()).toBe(theme)
    expect(useThemeStore.getState().theme).toBe(theme)
    expect(shown()).toBe(painted)
    await unmount()
  })

  it.each([
    ['nothing is saved', null],
    ['what is saved cannot be read', 'not json'],
  ])('is dark when %s', async (_, stored) => {
    const { useThemeStore, unmount } = await loadPage(stored)

    expect(useThemeStore.getState().theme).toBe('dark')
    expect(shown()).toBe('dark')
    await unmount()
  })
})

describe('signing in', () => {
  it('the choice on the server still wins', async () => {
    const { useAuthStore, unmount } = await loadPage(state('light'))

    await act(async () => {
      useAuthStore.setState({ user: { id: 'u', preferences: { theme: 'dark' } } as never })
    })

    expect(saved()).toBe('dark')
    expect(shown()).toBe('dark')
    await unmount()
  })
})
