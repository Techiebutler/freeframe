/**
 * The notification drawer opens against the sidebar's right edge, wherever that is.
 *
 * Its backdrop and panel were pinned at 52px, the collapsed rail's width. With
 * the sidebar expanded to 220px the drawer opened on top of it, the same bug
 * #369 fixed for the uploads panel. The expanded offset is gated at `md` for
 * the same reason: the drawer is a hard 380px, and 220 + 380 does not fit on a
 * phone.
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('@/stores/notification-store', () => ({
  useNotificationStore: () => ({
    notifications: [],
    isLoading: false,
    fetchNotifications: vi.fn(),
    markAllRead: vi.fn(),
    unreadCount: 0,
  }),
}))

import { NotificationDrawer } from '@/components/layout/notification-drawer'

function render_(railCollapsed: boolean) {
  const props = { open: true, onClose: () => {} }
  return render(<NotificationDrawer {...props} railCollapsed={railCollapsed} />)
}

describe('the notification drawer beside the sidebar', () => {
  it('sits beside the rail while the sidebar is collapsed', () => {
    const { container } = render_(true)

    const panel = container.querySelector('.left-safe') as HTMLElement
    const backdrop = container.querySelector('.fixed.z-40') as HTMLElement

    expect(panel.className).toContain('[--ff-left:52px]')
    expect(panel.className).not.toContain('md:[--ff-left:220px]')
    expect(backdrop.className).toContain('left-[52px]')
    expect(backdrop.className).not.toContain('md:left-[220px]')
  })

  it('moves out to the expanded sidebar\'s edge instead of covering it', () => {
    const { container } = render_(false)

    const panel = container.querySelector('.left-safe') as HTMLElement
    const backdrop = container.querySelector('.fixed.z-40') as HTMLElement

    expect(panel.className).toContain('md:[--ff-left:220px]')
    expect(backdrop.className).toContain('md:left-[220px]')
  })

  it('keeps the collapsed offset as the base, so a phone never loses the drawer', () => {
    const { container } = render_(false)

    const panel = container.querySelector('.left-safe') as HTMLElement
    const backdrop = container.querySelector('.fixed.z-40') as HTMLElement

    // Base offset is always the 52px rail; the 220px one only applies from md up.
    expect(panel.className).toContain('[--ff-left:52px]')
    expect(backdrop.className).toContain('left-[52px]')
  })
})
