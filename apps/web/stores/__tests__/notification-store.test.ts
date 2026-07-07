import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useNotificationStore } from '../notification-store'
import type { Notification } from '@/types'

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
  },
}))

import { api } from '@/lib/api'

const mockNotifications: Notification[] = [
  {
    id: 'n1',
    user_id: 'user-1',
    comment_id: null,
    asset_id: 'asset-1',
    type: 'comment',
    read: false,
    created_at: '2024-01-01T00:00:00Z',
    asset_name: null,
    actor_name: null,
    comment_preview: null,
    project_id: null,
  },
  {
    id: 'n2',
    user_id: 'user-1',
    comment_id: null,
    asset_id: 'asset-2',
    type: 'mention',
    read: true,
    created_at: '2024-01-02T00:00:00Z',
    asset_name: null,
    actor_name: null,
    comment_preview: null,
    project_id: null,
  },
]

describe('Notification store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useNotificationStore.setState({
      notifications: [],
      unreadCount: 0,
      isLoading: false,
    })
  })

  it('has correct initial state', () => {
    const state = useNotificationStore.getState()
    expect(state.notifications).toEqual([])
    expect(state.unreadCount).toBe(0)
    expect(state.isLoading).toBe(false)
  })

  it('incrementUnread increments the unread count', () => {
    useNotificationStore.setState({ unreadCount: 3 })
    useNotificationStore.getState().incrementUnread()
    expect(useNotificationStore.getState().unreadCount).toBe(4)
  })

  it('incrementUnread increments from 0', () => {
    useNotificationStore.getState().incrementUnread()
    expect(useNotificationStore.getState().unreadCount).toBe(1)
  })

  it('fetchNotifications loads notifications and updates unread count', async () => {
    vi.mocked(api.get).mockResolvedValue(mockNotifications)

    await useNotificationStore.getState().fetchNotifications()

    const state = useNotificationStore.getState()
    expect(state.notifications).toEqual(mockNotifications)
    expect(state.unreadCount).toBe(1) // only n1 is unread
    expect(state.isLoading).toBe(false)
  })

  it('markAllRead resets unread count to 0', async () => {
    vi.mocked(api.post).mockResolvedValue(undefined)
    useNotificationStore.setState({
      notifications: mockNotifications,
      unreadCount: 1,
    })

    await useNotificationStore.getState().markAllRead()

    const state = useNotificationStore.getState()
    expect(state.unreadCount).toBe(0)
    expect(state.notifications.every((n) => n.read)).toBe(true)
    expect(api.post).toHaveBeenCalledWith('/me/notifications/read-all')
  })

  it('markAsRead marks a specific notification as read', async () => {
    vi.mocked(api.post).mockResolvedValue(undefined)
    useNotificationStore.setState({
      notifications: mockNotifications,
      unreadCount: 1,
    })

    await useNotificationStore.getState().markAsRead('n1')

    const state = useNotificationStore.getState()
    expect(state.notifications.find((n) => n.id === 'n1')?.read).toBe(true)
    expect(state.unreadCount).toBe(0)
    expect(api.post).toHaveBeenCalledWith('/me/notifications/n1/read')
  })
})
