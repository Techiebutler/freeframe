/**
 * The uploads panel opens beside the rail (#369), and the rail stays usable
 * while it is open (#383).
 *
 * The backdrop that catches a click outside the panel was `fixed inset-0 z-40`,
 * over the sidebar's `z-30`. Measured at 1400x900 with the panel open, rail
 * collapsed or expanded: `elementFromPoint` at the centre of every rail control
 * (Projects, Notifications, Uploads, the account menu, the collapse toggle)
 * returned the backdrop, so a click on Notifications only closed the panel and
 * opened nothing. The backdrop now starts where the rail ends, as the
 * notification drawer's does.
 *
 * jsdom cannot hit-test, so the geometry is checked through the classes and
 * the rail's own behaviour through clicks.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The panel's infinite scroll, which jsdom has no implementation for.
vi.stubGlobal(
  'IntersectionObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn().mockResolvedValue([]) },
}))

import { UploadsPanel } from '../uploads-panel'
import { useUploadStore } from '@/stores/upload-store'
import { signInAs } from '@/test/upload-session'

beforeEach(() => {
  signInAs('u1')
  useUploadStore.setState({ files: [], panelOpen: true, historyLoaded: true, historyHasMore: false })
})

/** The backdrop is the element rendered just before the panel. */
function backdrop() {
  const panel = screen.getByRole('heading', { name: /Uploads/ }).closest('.z-50')
  if (!panel?.previousElementSibling) throw new Error('no backdrop before the panel')
  return panel.previousElementSibling
}
const classes = (el: Element) => el.className.split(/\s+/)

describe('the uploads panel backdrop', () => {
  it('leaves the collapsed rail uncovered', () => {
    render(<UploadsPanel railCollapsed />)

    const b = backdrop()
    expect(classes(b)).not.toContain('inset-0')
    expect(classes(b)).toEqual(expect.arrayContaining(['fixed', 'top-0', 'right-0', 'bottom-0', 'left-[52px]', 'z-40']))
    expect(classes(b)).not.toContain('md:left-[220px]')
  })

  it('leaves the expanded rail uncovered from md up, as the panel is offset', () => {
    render(<UploadsPanel railCollapsed={false} />)

    expect(classes(backdrop())).toEqual(expect.arrayContaining(['left-[52px]', 'md:left-[220px]']))
  })

  it('still closes the panel on a click outside it', () => {
    render(<UploadsPanel railCollapsed />)

    fireEvent.click(backdrop())

    expect(useUploadStore.getState().panelOpen).toBe(false)
  })
})
