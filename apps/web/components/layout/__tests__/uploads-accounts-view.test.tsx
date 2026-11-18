/**
 * The uploads a person sees are their own (spec goals 9 and 10).
 *
 * Every row stays in the store, whichever account added it, so that switching
 * back finds it again; the sidebar badge and the panel show only the rows of
 * the account signed in now. The account is the access token's `sub`, which
 * another tab can change at any moment: the views follow it even though no row
 * changed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

// Leaving the Active tab switches on the panel's infinite scroll, which jsdom
// has no implementation for.
vi.stubGlobal(
  'IntersectionObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

vi.mock('next/navigation', () => ({ usePathname: () => '/projects' }))
const { stable } = vi.hoisted(() => ({
  stable: {
    auth: { user: { name: 'Ada', email: 'ada@example.com' }, logout: () => {}, isSuperAdmin: false },
    notifications: { unreadCount: 0, fetchNotifications: () => {} },
    branding: { orgName: '', orgLogoDark: null, orgLogoLight: null },
  },
}))
vi.mock('@/stores/auth-store', () => ({ useAuthStore: () => stable.auth }))
vi.mock('@/stores/notification-store', () => ({ useNotificationStore: () => stable.notifications }))
vi.mock('@/components/shared/branding-provider', () => ({ useBranding: () => stable.branding }))
vi.mock('@/hooks/use-resolved-theme', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('@/components/shared/avatar', () => ({ Avatar: () => null }))
vi.mock('@/components/shared/themed-default-logo', () => ({ ThemedDefaultLogo: () => null }))
vi.mock('@/components/shared/storage-usage', () => ({ StorageUsage: () => null, StorageRing: () => null }))
vi.mock('@/components/layout/notification-drawer', () => ({ NotificationDrawer: () => null }))
vi.mock('swr', () => ({ default: () => ({ data: undefined }), mutate: vi.fn() }))
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn() },
}))

import { Sidebar } from '../sidebar'
import { UploadsPanel } from '../uploads-panel'
import { useUploadStore, __uploadQueueTesting as testing } from '@/stores/upload-store'
import { signInAs, signOutElsewhere, row } from '@/test/upload-session'

const badge = () => screen.getByTitle('Uploads').textContent
const panelRows = () => screen.queryAllByTestId('upload-row')
/** The count beside a tab of the panel, e.g. `All` → 2. */
const tabCount = (tab: string) =>
  screen.getByRole('button', { name: new RegExp(`^${tab}`) }).textContent?.replace(tab, '').trim()

beforeEach(() => {
  testing.reset()
  window.localStorage.clear()
  useUploadStore.setState({ files: [], panelOpen: true, historyLoaded: true, historyHasMore: false })
  signOutElsewhere()
})

describe('two accounts in one browser', () => {
  it('the badge and panel count only the current account\'s rows', () => {
    signInAs('u1')
    const mine = [
      row({ id: 'u1-sending', fileName: 'mine-1.mov', assetName: 'mine-1', status: 'uploading' }),
      row({ id: 'u1-processing', fileName: 'mine-2.mov', assetName: 'mine-2', status: 'processing' }),
    ]
    signInAs('u2')
    const theirs = [
      row({ id: 'u2-sending', fileName: 'theirs-1.mov', assetName: 'theirs-1', status: 'uploading' }),
      row({ id: 'u2-processing', fileName: 'theirs-2.mov', assetName: 'theirs-2', status: 'processing' }),
      row({ id: 'u2-resume', fileName: 'theirs-3.mov', assetName: 'theirs-3', status: 'interrupted', queuedResume: true }),
    ]
    signInAs('u1')
    useUploadStore.setState({ files: [...mine, ...theirs] })

    render(
      <>
        <Sidebar collapsed onToggle={() => {}} />
        <UploadsPanel />
      </>,
    )

    expect(badge()).toBe('2')
    expect(panelRows()).toHaveLength(2)
    expect(screen.getByText('mine-1')).toBeTruthy()
    expect(screen.queryByText('theirs-1')).toBeNull()
    expect(tabCount('All')).toBe('2')
    expect(tabCount('Active')).toBe('2')

    // Another tab signs in as u2. No row changed, and the views follow.
    act(() => signInAs('u2'))
    expect(badge()).toBe('3')
    expect(panelRows()).toHaveLength(3)
    expect(screen.queryByText('mine-1')).toBeNull()
    expect(tabCount('All')).toBe('3')

    // Signed out: nobody's rows.
    act(() => signOutElsewhere())
    expect(badge()).toBe('')
    expect(panelRows()).toHaveLength(0)
    // Every row is still there for its owner to come back to.
    expect(useUploadStore.getState().files).toHaveLength(5)
  })
})
