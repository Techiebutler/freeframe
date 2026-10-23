/**
 * The rail while the uploads panel is open (#383).
 *
 * The rail used to be under the panel's backdrop, so nothing on it could be
 * clicked until the panel closed. Now that it can be, a rail control that opens
 * something else in the panel's place closes the panel first: the notification
 * drawer and the uploads panel are both 380px at the rail's edge, and both
 * open at once would put one squarely over the other.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('next/navigation', () => ({ usePathname: () => '/projects/p1' }))
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
vi.mock('@/components/layout/notification-drawer', () => ({
  NotificationDrawer: ({ open }: { open: boolean }) => (open ? <div>notification drawer</div> : null),
}))
vi.mock('swr', () => ({ default: () => ({ data: undefined }), mutate: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn().mockResolvedValue([]), post: vi.fn() } }))

import { Sidebar } from '../sidebar'
import { useUploadStore } from '@/stores/upload-store'
import { signInAs } from '@/test/upload-session'

beforeEach(() => {
  signInAs('u1')
  useUploadStore.setState({ files: [], panelOpen: true })
})

describe('the rail with the uploads panel open', () => {
  it('Notifications opens the drawer in place of the panel', () => {
    render(<Sidebar collapsed onToggle={() => {}} />)

    fireEvent.click(screen.getByTitle('Notifications'))

    expect(screen.getByText('notification drawer')).toBeTruthy()
    expect(useUploadStore.getState().panelOpen).toBe(false)
  })

  it('a nav link closes the panel as it navigates', () => {
    render(<Sidebar collapsed onToggle={() => {}} />)

    fireEvent.click(screen.getByTitle('Projects'))

    expect(useUploadStore.getState().panelOpen).toBe(false)
  })

  it('Uploads still toggles the panel shut', () => {
    render(<Sidebar collapsed onToggle={() => {}} />)

    fireEvent.click(screen.getByTitle('Uploads'))

    expect(useUploadStore.getState().panelOpen).toBe(false)
  })
})
