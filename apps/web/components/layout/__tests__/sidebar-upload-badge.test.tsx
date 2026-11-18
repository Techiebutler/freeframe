/**
 * The count on the sidebar's Uploads button is the uploads that are on their
 * way: waiting for a turn, starting, sending, or being processed. A resume that
 * is waiting for its turn is one of them -- it is `interrupted` in the store
 * until the turn comes, but the user has asked for it and it will move without
 * another click, which is what the badge tells them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

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
vi.mock('@/lib/api', () => ({ api: { get: vi.fn().mockResolvedValue([]), post: vi.fn() } }))

import { Sidebar } from '../sidebar'
import { useUploadStore } from '@/stores/upload-store'
import { signInAs, row } from '@/test/upload-session'

const badge = () => screen.getByTitle('Uploads').textContent

describe('the Uploads badge in the sidebar', () => {
  beforeEach(() => {
    useUploadStore.setState({ files: [] })
    // The badge counts the signed-in account's uploads.
    signInAs('u1')
  })

  it('counts every upload on its way, including a resume waiting for its turn', () => {
    useUploadStore.setState({
      files: [
        row({ id: 'queued', status: 'queued' }),
        row({ id: 'starting', status: 'starting' }),
        row({ id: 'uploading', status: 'uploading' }),
        row({ id: 'processing', status: 'processing' }),
        row({ id: 'waiting-resume', status: 'interrupted', queuedResume: true }),
        // Not on their way: nothing moves them without a click, or it is not this tab's.
        row({ id: 'stopped', status: 'interrupted' }),
        row({ id: 'elsewhere', status: 'elsewhere' }),
        row({ id: 'failed', status: 'failed' }),
        row({ id: 'cancelled', status: 'cancelled' }),
        row({ id: 'complete', status: 'complete' }),
      ],
    })

    render(<Sidebar collapsed onToggle={() => {}} />)

    expect(badge()).toBe('5')
  })

  it('follows a resume as it is cancelled and as its turn comes', () => {
    useUploadStore.setState({ files: [row({ id: 'r', status: 'interrupted', queuedResume: true })] })
    render(<Sidebar collapsed onToggle={() => {}} />)
    expect(badge()).toBe('1')

    act(() => {
      useUploadStore.setState((s) => ({
        files: s.files.map((f) => ({ ...f, queuedResume: undefined })),
      }))
    })
    expect(badge()).toBe('')
  })
})
