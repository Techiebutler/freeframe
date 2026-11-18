import { create } from 'zustand'
import { Notification } from '@/types'
import { api } from '@/lib/api'

interface NotificationState {
  notifications: Notification[]
  unreadCount: number
  isLoading: boolean
  fetchNotifications: () => Promise<void>
  markAsRead: (id: string) => Promise<void>
  markAllRead: () => Promise<void>
  incrementUnread: () => void
}

export const useNotificationStore = create<NotificationState>()((set, get) => ({
  notifications: [],
  unreadCount: 0,
  isLoading: false,

  fetchNotifications: async () => {
    set({ isLoading: true })
    try {
      const notifications = await api.get<Notification[]>('/me/notifications')
      const unreadCount = notifications.filter((n) => !n.read).length
      set({ notifications, unreadCount })
    } catch {
      // A failed fetch keeps the current list and unread count. The callers
      // run this from effects without a .catch, so rethrowing would leave an
      // unhandled rejection.
    } finally {
      set({ isLoading: false })
    }
  },

  markAsRead: async (id: string) => {
    await api.post(`/me/notifications/${id}/read`)
    set((state) => {
      const notifications = state.notifications.map((n) =>
        n.id === id ? { ...n, read: true } : n
      )
      const unreadCount = notifications.filter((n) => !n.read).length
      return { notifications, unreadCount }
    })
  },

  markAllRead: async () => {
    await api.post('/me/notifications/read-all')
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    }))
  },

  incrementUnread: () => {
    set((state) => ({ unreadCount: state.unreadCount + 1 }))
  },
}))
