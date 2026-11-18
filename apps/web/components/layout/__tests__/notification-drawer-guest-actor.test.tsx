/**
 * A notification caused by a share-link guest names the guest (#455).
 *
 * The API had no actor for a guest's comment, so the drawer read "Someone
 * mentioned you". It now sends the guest's name with `actor_is_guest`, and the
 * drawer marks it "(guest)", since a guest is not an account in the workspace.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Notification } from '@/types'

const state = vi.hoisted(() => ({ notifications: [] as unknown[] }))

vi.mock('@/stores/notification-store', () => ({
  useNotificationStore: () => ({
    notifications: state.notifications,
    isLoading: false,
    fetchNotifications: vi.fn(),
    markAllRead: vi.fn(),
    markAsRead: vi.fn(),
    unreadCount: 0,
  }),
}))

import { NotificationDrawer } from '@/components/layout/notification-drawer'

function notification(over: Partial<Notification>): Notification {
  return {
    id: 'n1',
    user_id: 'u1',
    comment_id: 'c1',
    asset_id: 'a1',
    type: 'mention',
    read: true,
    created_at: new Date().toISOString(),
    asset_name: 'Cut 3',
    actor_name: null,
    comment_preview: null,
    project_id: 'p1',
    ...over,
  }
}

function render_(n: Notification) {
  state.notifications = [n]
  render(<NotificationDrawer open onClose={() => {}} railCollapsed />)
}

describe('the actor of a notification', () => {
  it('names a guest and marks them as one', () => {
    render_(notification({ actor_name: 'Jane', actor_is_guest: true }))
    expect(screen.getByText('Jane (guest) mentioned you on Cut 3')).toBeTruthy()
  })

  it('names a guest who replied', () => {
    render_(notification({ type: 'comment', actor_name: 'Jane', actor_is_guest: true }))
    expect(screen.getByText('Jane (guest) commented on Cut 3')).toBeTruthy()
  })

  it('names a registered user without the guest mark', () => {
    render_(notification({ actor_name: 'Priya', actor_is_guest: false }))
    expect(screen.getByText('Priya mentioned you on Cut 3')).toBeTruthy()
  })

  it('still reads "Someone" when there is no actor at all', () => {
    render_(notification({ actor_name: null, actor_is_guest: false }))
    expect(screen.getByText('Someone mentioned you on Cut 3')).toBeTruthy()
  })
})
