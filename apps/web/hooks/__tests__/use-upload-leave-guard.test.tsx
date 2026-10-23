/**
 * The leave-page warning (spec goal 12).
 *
 * Armed while this account has an upload that closing the tab would lose: one
 * waiting for its turn (new, held, or a resume the user asked for), being
 * started, or being sent. The listener is on the window only while armed, since
 * Firefox refuses to keep a page in its back/forward cache while one is
 * attached. A session that ends by force never prompts: it has already cleared
 * the tokens, so a "Stay" would leave a tokenless tab that loops.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Signing in as another account asks for that account's history and rows.
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn() },
}))

import { useUploadLeaveGuard } from '../use-upload-leave-guard'
import { clearTokens, refreshAccessToken, resetLeaveGuardSuppression, setTokens } from '@/lib/auth'
import {
  useUploadStore, uploadsThatWouldStop, __uploadQueueTesting as testing,
  type UploadFile, type UploadStatus,
} from '@/stores/upload-store'
import { rehydrate } from '@/test/upload-queue-server'
import { signInAs, signOutElsewhere, tokenFor, row } from '@/test/upload-session'

type Spy = { mock: { calls: unknown[][] }; mockClear: () => unknown }
let addSpy: Spy
let removeSpy: Spy

/** The calls a spy on the window saw for `beforeunload`: `[type, listener]`. */
const callsFor = (spy: Spy) => spy.mock.calls.filter(([type]) => type === 'beforeunload')

/** What the browser does as the page is about to go: true when the prompt is asked for. */
function leaves(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

const setRows = (files: UploadFile[]) => act(() => { useUploadStore.setState({ files }) })

/** A row of whoever is signed in now, in a state that closing the tab would lose. */
const losing: Array<[string, Partial<UploadFile>]> = [
  ['queued', { status: 'queued' }],
  ['held (a queued row with a hold reason)', { status: 'queued', holdReason: 'storage' }],
  ['starting', { status: 'starting' }],
  ['uploading', { status: 'uploading' }],
  ['finalizing (an uploading row waiting on storage)', { status: 'uploading', finalizing: true }],
  ['a resume waiting for its turn', { status: 'interrupted', queuedResume: true }],
]

/** Nothing running here, nothing waiting to run: a close loses none of it. */
const harmless: UploadStatus[] = ['interrupted', 'elsewhere', 'processing', 'complete', 'failed', 'cancelled']

beforeEach(() => {
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [] })
  resetLeaveGuardSuppression()
  signOutElsewhere()
  signInAs('u1')
  addSpy = vi.spyOn(window, 'addEventListener')
  removeSpy = vi.spyOn(window, 'removeEventListener')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the leave guard', () => {
  it('adds the listener only while rows are moving or waiting, and removes it after', () => {
    renderHook(() => useUploadLeaveGuard())
    expect(callsFor(addSpy)).toHaveLength(0)
    expect(leaves()).toBe(false)

    for (const [, over] of losing) {
      addSpy.mockClear()
      removeSpy.mockClear()

      setRows([row({ id: 'r', ...over })])
      expect(callsFor(addSpy)).toHaveLength(1)
      expect(leaves()).toBe(true)

      // Progress and status churn on a row that stays armed is not a new listener.
      setRows([row({ id: 'r', ...over, progress: 40 }), row({ id: 'r2', ...over })])
      expect(callsFor(addSpy)).toHaveLength(1)
      expect(callsFor(removeSpy)).toHaveLength(0)

      setRows([])
      expect(callsFor(removeSpy)).toHaveLength(1)
      expect(callsFor(removeSpy)[0][1]).toBe(callsFor(addSpy)[0][1])
      expect(leaves()).toBe(false)
    }

    // Finishing the last row takes it off, too.
    setRows([row({ id: 'r', status: 'uploading' })])
    expect(leaves()).toBe(true)
    setRows([row({ id: 'r', status: 'processing' })])
    expect(leaves()).toBe(false)

    for (const status of harmless) {
      addSpy.mockClear()
      setRows([row({ id: 'r', status })])
      expect(callsFor(addSpy), status).toHaveLength(0)
      expect(leaves(), status).toBe(false)
    }
  })

  it('removes the listener when the page that mounted the guard goes away', () => {
    const { unmount } = renderHook(() => useUploadLeaveGuard())
    setRows([row({ id: 'r', status: 'uploading' })])
    expect(leaves()).toBe(true)

    unmount()

    expect(leaves()).toBe(false)
  })

  it('hidden rows of another account do not arm it', () => {
    signInAs('u2')
    const theirs = [
      row({ id: 'u2-sending', status: 'uploading' }),
      row({ id: 'u2-queued', status: 'queued' }),
      row({ id: 'u2-resume', status: 'interrupted', queuedResume: true }),
    ]
    signInAs('u1')
    // A row with no owner is nobody's and shows to nobody.
    const ownerless = row({ id: 'nobodys', status: 'uploading', ownerId: undefined })
    renderHook(() => useUploadLeaveGuard())

    setRows([...theirs, ownerless])

    expect(callsFor(addSpy)).toHaveLength(0)
    expect(leaves()).toBe(false)

    // The same rows arm it for the account that added them.
    act(() => signInAs('u2'))
    expect(leaves()).toBe(true)
    act(() => signOutElsewhere())
    expect(leaves()).toBe(false)
  })

  it('does not arm it for a row another tab is sending', () => {
    // Rows another tab is sending come out of storage as `elsewhere` (or plain
    // `interrupted`), never `uploading` or `starting`, so a tab counts only
    // what it is running or queueing itself. `uploadsThatWouldStop` agrees.
    const now = Date.now()
    const sentByOtherTab = {
      versionId: 'v1', uploadId: 'up1', ownerTab: 'another-tab', heartbeatAt: now, ownerId: 'u1',
    }
    const rows = rehydrate([
      row({ id: 'sending', status: 'uploading', ...sentByOtherTab }),
      row({ id: 'resuming', status: 'starting', resuming: true, ...sentByOtherTab }),
      row({ id: 'waiting', status: 'interrupted', queuedResume: true, ...sentByOtherTab }),
      row({ id: 'new', status: 'queued', ownerId: 'u1' }),
    ])
    renderHook(() => useUploadLeaveGuard())

    setRows(rows)

    expect(rows.map((f) => f.status)).not.toContain('uploading')
    expect(rows.map((f) => f.status)).not.toContain('starting')
    expect(rows.map((f) => f.status)).not.toContain('queued')
    expect(rows.some((f) => f.queuedResume)).toBe(false)
    expect(leaves()).toBe(false)
    expect(uploadsThatWouldStop()).toBe(0)
  })

  it('the handler prevents default', () => {
    renderHook(() => useUploadLeaveGuard())
    setRows([row({ id: 'r', status: 'uploading' })])
    const handler = callsFor(addSpy)[0][1] as (e: unknown) => void

    // Chromium wants `returnValue` set as well as `preventDefault()`; Firefox
    // and Safari take either.
    const event = { preventDefault: vi.fn(), returnValue: 'unset' }
    handler(event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.returnValue).toBe('')
  })

  it('a forced clearTokens suppresses it', async () => {
    // A browser runs `beforeunload` as the navigation starts, inside the
    // assignment, so the flag has to be up by then.
    let prompted: boolean | null = null
    let href = ''
    vi.stubGlobal('location', {
      set href(url: string) {
        prompted = leaves()
        href = url
      },
      get href() {
        return href
      },
    })
    renderHook(() => useUploadLeaveGuard())
    setRows([row({ id: 'r', status: 'uploading' })])
    const handler = callsFor(addSpy)[0][1] as (e: unknown) => void

    // A refused refresh token ends the session, and a missing one does too.
    for (const refresh of ['stale-refresh-token', null]) {
      resetLeaveGuardSuppression()
      prompted = null
      href = ''
      window.localStorage.clear()
      // In `act`: the session the last pass ended hid this account's rows, and
      // signing back in shows them again, which re-arms the guard on a render.
      act(() => signInAs('u1'))
      if (refresh) window.localStorage.setItem('ff_refresh_token', refresh)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }))
      expect(leaves(), `before the session ends (${refresh})`).toBe(true)

      await refreshAccessToken()

      expect(window.location.href, `ended (${refresh})`).toBe('/login')
      expect(prompted, `prompted on the way out (${refresh})`).toBe(false)
      expect(leaves(), `after (${refresh})`).toBe(false)
      const event = { preventDefault: vi.fn(), returnValue: 'unset' }
      handler(event)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(event.returnValue).toBe('unset')
    }
  })

  it('prompts again once the session is back', () => {
    // The suppression is for the navigation that follows `clearTokens`. If that
    // load is aborted and the user signs in again on the same document, or the
    // page comes back from the back/forward cache, the session is there and the
    // uploads are at risk again.
    vi.stubGlobal('location', { href: '' })
    renderHook(() => useUploadLeaveGuard())
    setRows([row({ id: 'r', status: 'uploading' })])
    expect(leaves()).toBe(true)

    clearTokens()
    expect(leaves()).toBe(false)

    setTokens(tokenFor('u1'), 'refresh-u1')
    expect(leaves()).toBe(true)
  })
})
