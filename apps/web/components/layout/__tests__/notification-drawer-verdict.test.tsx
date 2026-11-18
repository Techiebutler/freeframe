/**
 * An approval notification names the verdict that was given.
 *
 * The API stores the verdict in `detail` and the actor's name in `actor_name`,
 * with "(guest)" already part of the name for a share-link guest, so the drawer
 * must not add a second tag. A notification with no `detail` keeps the old text.
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
    comment_id: null,
    asset_id: 'a1',
    type: 'approval',
    read: true,
    created_at: new Date().toISOString(),
    asset_name: 'clip',
    actor_name: 'Priya',
    comment_preview: null,
    project_id: 'p1',
    ...over,
  }
}

function render_(n: Notification) {
  state.notifications = [n]
  render(<NotificationDrawer open onClose={() => {}} railCollapsed />)
}

describe('an approval notification', () => {
  it('says a guest asked for changes, with the tag the API already put on the name', () => {
    render_(notification({ detail: 'changes_requested', actor_name: 'Dana (guest)' }))
    expect(screen.getByText('Dana (guest) asked for changes on clip')).toBeTruthy()
  })

  it('says a member approved', () => {
    render_(notification({ detail: 'approved' }))
    expect(screen.getByText('Priya approved clip')).toBeTruthy()
  })

  it('says a member rejected', () => {
    render_(notification({ detail: 'rejected' }))
    expect(screen.getByText('Priya rejected clip')).toBeTruthy()
  })

  it('does not tag the name a second time when the API also flags a guest', () => {
    render_(notification({ detail: 'approved', actor_name: 'Dana (guest)', actor_is_guest: true }))
    expect(screen.getByText('Dana (guest) approved clip')).toBeTruthy()
  })

  it('keeps the old text when there is no detail', () => {
    render_(notification({ detail: null }))
    expect(screen.getByText('Priya updated approval on clip')).toBeTruthy()
  })

  it('keeps the old text for a detail it does not know', () => {
    render_(notification({ detail: 'something_new' }))
    expect(screen.getByText('Priya updated approval on clip')).toBeTruthy()
  })
})
