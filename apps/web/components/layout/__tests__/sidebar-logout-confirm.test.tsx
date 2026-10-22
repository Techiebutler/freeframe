/**
 * Log out asks first when it would stop uploads (spec goal 12).
 *
 * Logging out clears the tokens and loads /login, and a page that is gone takes
 * every upload it was running or holding with it. So with any of the signed-in
 * account's uploads queued, starting or sending, the menu item opens a
 * confirmation before a single token is cleared. With none, it logs out at
 * once. Another account's hidden rows are not this account's to lose and are
 * not in the count.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('next/navigation', () => ({ usePathname: () => '/projects' }))
const { stable, opened } = vi.hoisted(() => ({
  stable: {
    notifications: { unreadCount: 0, fetchNotifications: () => {} },
    branding: { orgName: '', orgLogoDark: null, orgLogoLight: null },
  },
  // What the page looked like in each render that asked for the dialog open.
  opened: [] as Array<{ pointerEvents: string; menuOpen: boolean }>,
}))
vi.mock('@/stores/notification-store', () => ({ useNotificationStore: () => stable.notifications }))
vi.mock('@/components/shared/branding-provider', () => ({ useBranding: () => stable.branding }))
vi.mock('@/hooks/use-resolved-theme', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('@/components/shared/avatar', () => ({ Avatar: () => null }))
vi.mock('@/components/shared/themed-default-logo', () => ({ ThemedDefaultLogo: () => null }))
vi.mock('@/components/shared/storage-usage', () => ({ StorageUsage: () => null, StorageRing: () => null }))
vi.mock('@/components/layout/notification-drawer', () => ({ NotificationDrawer: () => null }))
vi.mock('swr', () => ({ default: () => ({ data: undefined }), mutate: vi.fn() }))
vi.mock('@/components/ui/confirm-dialog', async (orig) => {
  const real = await orig<typeof import('@/components/ui/confirm-dialog')>()
  return {
    ...real,
    ConfirmDialog: (props: Parameters<typeof real.ConfirmDialog>[0]) => {
      if (props.open) {
        opened.push({
          pointerEvents: document.body.style.pointerEvents,
          menuOpen: !!document.querySelector('[role="menu"]'),
        })
      }
      return <real.ConfirmDialog {...props} />
    },
  }
})
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn() },
}))

import { Sidebar } from '../sidebar'
import { useAuthStore } from '@/stores/auth-store'
import { useUploadStore, uploadsThatWouldStop, __uploadQueueTesting as testing } from '@/stores/upload-store'
import { useUploadLeaveGuard } from '@/hooks/use-upload-leave-guard'
import { isLeaveGuardSuppressed, resetLeaveGuardSuppression, setTokens } from '@/lib/auth'
import { signInAs, signOutElsewhere, tokenFor, row } from '@/test/upload-session'
import type { UploadFile } from '@/stores/upload-store'
import type { User } from '@/types'

const user = () => userEvent.setup({ pointerEventsCheck: 0 })

/** The store's own `logout`, before any test wraps it. */
const realLogout = useAuthStore.getState().logout
let logout: Mock<() => void>
/** Whether the account menu was still on screen each time `logout` ran. */
const menuOpenAtLogout: boolean[] = []

/** What the dashboard shell mounts beside the rail. */
function Guard() {
  useUploadLeaveGuard()
  return null
}

/** Whether the browser's own prompt was asked for as the page navigated away. */
let prompted: boolean | null = null

/** Open the account menu and pick Log out. */
async function pickLogOut() {
  const u = user()
  await u.click(screen.getByTitle('Ada'))
  await u.click(await screen.findByRole('menuitem', { name: 'Log out' }))
  return u
}

const hasTokens = () =>
  window.localStorage.getItem('ff_access_token') === tokenFor('u1') &&
  window.localStorage.getItem('ff_refresh_token') === 'refresh-u1'

/** Rows of `sub`, built while `sub` is the signed-in account, then back to u1. */
function rowsOf(sub: string, rows: Array<Partial<UploadFile>>): UploadFile[] {
  signInAs(sub)
  const built = rows.map((r) => row(r))
  signInAs('u1')
  return built
}

beforeEach(() => {
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [] })
  resetLeaveGuardSuppression()
  prompted = null
  let href = ''
  // A browser runs `beforeunload` as the navigation starts, inside the assignment.
  vi.stubGlobal('location', {
    set href(url: string) {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      prompted = event.defaultPrevented
      href = url
    },
    get href() {
      return href
    },
  })
  opened.length = 0
  // Counts the calls, and still does the real thing.
  menuOpenAtLogout.length = 0
  logout = vi.fn<() => void>(() => {
    menuOpenAtLogout.push(!!document.querySelector('[role="menu"]'))
    realLogout()
  })
  useAuthStore.setState({
    user: { id: 'u1', name: 'Ada', email: 'ada@example.com', avatar_url: null, avatar_color: null } as User,
    isAuthenticated: true,
    isSuperAdmin: false,
    logout,
  })
  signOutElsewhere()
  signInAs('u1')
  setTokens(tokenFor('u1'), 'refresh-u1')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Log out in the account menu', () => {
  it('logout with uploads asks first and cancelling keeps the tokens', async () => {
    useUploadStore.setState({
      files: [
        row({ id: 'sending', status: 'uploading' }),
        row({ id: 'waiting', status: 'queued' }),
        row({ id: 'resume', status: 'interrupted', queuedResume: true }),
      ],
    })
    render(<Sidebar collapsed onToggle={() => {}} />)

    const u = await pickLogOut()

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('3 uploads will stop. Log out anyway?')).toBeTruthy()
    // Nothing is cleared while it asks.
    expect(hasTokens()).toBe(true)
    expect(window.location.href).toBe('')
    expect(useAuthStore.getState().isAuthenticated).toBe(true)

    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(hasTokens()).toBe(true)
    expect(window.location.href).toBe('')
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(isLeaveGuardSuppressed()).toBe(false)
    expect(logout).not.toHaveBeenCalled()
    // The menu and the dialog each lock the page while open; neither may leave
    // it locked once the answer is no.
    expect(document.body.style.pointerEvents).not.toBe('none')
  })

  it('logs out once confirmed, and the browser is not asked to prompt again', async () => {
    useUploadStore.setState({ files: [row({ id: 'sending', status: 'uploading' })] })
    render(<><Guard /><Sidebar collapsed onToggle={() => {}} /></>)

    const u = await pickLogOut()
    const dialog = await screen.findByRole('dialog')
    await u.click(within(dialog).getByRole('button', { name: 'Log out' }))

    await waitFor(() => expect(window.location.href).toBe('/login'))
    expect(logout).toHaveBeenCalledTimes(1)
    expect(prompted).toBe(false)
    expect(window.localStorage.getItem('ff_access_token')).toBeNull()
    expect(window.localStorage.getItem('ff_refresh_token')).toBeNull()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(isLeaveGuardSuppressed()).toBe(true)
  })

  it('says "1 upload" for one', async () => {
    useUploadStore.setState({ files: [row({ id: 'sending', status: 'starting' })] })
    render(<Sidebar collapsed onToggle={() => {}} />)

    await pickLogOut()

    expect(await screen.findByText('1 upload will stop. Log out anyway?')).toBeTruthy()
  })

  it('logout with no uploads does not ask', async () => {
    useUploadStore.setState({
      files: [
        row({ id: 'stopped', status: 'interrupted' }),
        row({ id: 'processing', status: 'processing' }),
        row({ id: 'done', status: 'complete' }),
        row({ id: 'failed', status: 'failed' }),
        row({ id: 'elsewhere', status: 'elsewhere' }),
        ...rowsOf('u2', [{ id: 'theirs', status: 'uploading' }]),
      ],
    })
    render(<Sidebar collapsed onToggle={() => {}} />)

    await pickLogOut()

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(logout).toHaveBeenCalledTimes(1)
    // At once, inside the pick: with nothing to ask, nothing waits on the menu.
    expect(menuOpenAtLogout).toEqual([true])
    expect(window.location.href).toBe('/login')
    expect(window.localStorage.getItem('ff_access_token')).toBeNull()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })

  it('asks only once the menu has let go of the page', async () => {
    // The menu and the dialog each set `pointer-events: none` on <body> while
    // open and put back what they found. A dialog that opens while the closing
    // menu still holds the page saves that lock as the value to restore, and
    // with two copies of Radix's layer code installed it puts the lock back on
    // Cancel: nothing on the page can be clicked until a reload, which is the
    // one answer that was meant to leave the uploads alive. So the dialog is
    // asked for in the render after the menu has gone, as `item-menu` does.
    useUploadStore.setState({ files: [row({ id: 'sending', status: 'uploading' })] })
    render(<Sidebar collapsed onToggle={() => {}} />)

    await pickLogOut()
    await screen.findByRole('dialog')

    expect(opened.length).toBeGreaterThan(0)
    expect(opened[0]).toEqual({ pointerEvents: '', menuOpen: false })
  })

  it("another account's hidden rows are not counted in N", async () => {
    const theirs = rowsOf('u2', [
      { id: 'theirs-1', status: 'uploading' },
      { id: 'theirs-2', status: 'queued' },
      { id: 'theirs-3', status: 'starting' },
      { id: 'theirs-4', status: 'interrupted', queuedResume: true },
    ])
    useUploadStore.setState({
      files: [
        row({ id: 'mine-1', status: 'uploading' }),
        row({ id: 'mine-2', status: 'queued', holdReason: 'connection' }),
        row({ id: 'mine-done', status: 'processing' }),
        row({ id: 'nobodys', status: 'uploading', ownerId: undefined }),
        ...theirs,
      ],
    })

    expect(uploadsThatWouldStop()).toBe(2)

    render(<Sidebar collapsed onToggle={() => {}} />)
    await pickLogOut()

    expect(await screen.findByText('2 uploads will stop. Log out anyway?')).toBeTruthy()
  })
})

describe('uploadsThatWouldStop', () => {
  it('counts queued, starting, sending and queued-resume rows of the signed-in account', () => {
    useUploadStore.setState({
      files: [
        row({ id: 'queued', status: 'queued' }),
        row({ id: 'held', status: 'queued', holdReason: 'storage' }),
        row({ id: 'starting', status: 'starting' }),
        row({ id: 'uploading', status: 'uploading' }),
        row({ id: 'finalizing', status: 'uploading', finalizing: true }),
        row({ id: 'resume', status: 'interrupted', queuedResume: true }),
        row({ id: 'stopped', status: 'interrupted' }),
        row({ id: 'elsewhere', status: 'elsewhere' }),
        row({ id: 'processing', status: 'processing' }),
        row({ id: 'complete', status: 'complete' }),
        row({ id: 'failed', status: 'failed' }),
        row({ id: 'cancelled', status: 'cancelled' }),
      ],
    })

    expect(uploadsThatWouldStop()).toBe(6)
  })

  it('is zero with nobody signed in', () => {
    useUploadStore.setState({ files: [row({ id: 'uploading', status: 'uploading' })] })
    signOutElsewhere()

    expect(uploadsThatWouldStop()).toBe(0)
  })
})
