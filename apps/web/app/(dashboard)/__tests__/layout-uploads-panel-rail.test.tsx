/**
 * The uploads panel opens against the sidebar's right edge, wherever that is.
 *
 * It was pinned at 52px, the collapsed rail's width. With the sidebar expanded
 * to 220px the panel opened on top of it and cut every label back to its first
 * letter, which undoes the one thing expanding the sidebar is for.
 */
import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal(
  'IntersectionObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('next/navigation', () => ({ usePathname: () => '/projects/p1' }))
vi.mock('@/stores/auth-store', () => ({ useAuthStore: () => ({ fetchUser: vi.fn() }) }))
vi.mock('@/components/layout/sidebar', () => ({
  Sidebar: ({ onToggle }: { onToggle: () => void }) => <button onClick={onToggle}>toggle</button>,
}))
vi.mock('@/components/layout/header', () => ({ Header: () => null }))
vi.mock('@/components/layout/command-palette', () => ({ CommandPalette: () => null }))
vi.mock('@/components/layout/upload-sse-bridge', () => ({ UploadSSEBridge: () => null }))
vi.mock('@/components/shared/powered-by-badge', () => ({ PoweredByBadge: () => null }))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn().mockResolvedValue([]), post: vi.fn() } }))

import DashboardLayout from '../layout'
import { useUploadStore } from '@/stores/upload-store'

/** The panel's own box: the element that carries its left offset. */
function panelBox(): HTMLElement {
  return screen.getByText('Uploads', { selector: 'h2, h3, span, p' }).closest('.left-safe') as HTMLElement
}

describe('the uploads panel beside the sidebar', () => {
  it('sits beside the rail while the sidebar is collapsed', () => {
    useUploadStore.setState({ files: [], panelOpen: true, historyLoaded: true, historyHasMore: false })
    render(<DashboardLayout><div>page</div></DashboardLayout>)

    expect(panelBox().className).toContain('[--ff-left:52px]')
    expect(panelBox().className).not.toContain('md:[--ff-left:220px]')
  })

  it('moves out to the expanded sidebar\'s edge instead of covering it', () => {
    useUploadStore.setState({ files: [], panelOpen: true, historyLoaded: true, historyHasMore: false })
    render(<DashboardLayout><div>page</div></DashboardLayout>)

    fireEvent.click(screen.getByText('toggle'))

    expect(panelBox().className).toContain('md:[--ff-left:220px]')
  })

  it('keeps the collapsed offset as the base, so a phone never loses the panel', () => {
    // The panel is a hard 380px. 220 + 380 is wider than a phone, the page
    // root does not scroll sideways, and there is no gesture that reaches what
    // falls off -- so with the offset ungated the close button and the whole
    // tab bar sit outside the screen with only a backdrop tap to escape.
    useUploadStore.setState({ files: [], panelOpen: true, historyLoaded: true, historyHasMore: false })
    render(<DashboardLayout><div>page</div></DashboardLayout>)

    fireEvent.click(screen.getByText('toggle'))

    expect(panelBox().className).toContain('[--ff-left:52px]')
  })
})
