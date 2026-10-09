/**
 * The dashboard shell refuses a file drag that nothing inside it took.
 *
 * The project page closed its own element and stopped there, which is not the
 * page a user sees: the header, the sidebar rail and the attribution badge are
 * siblings of it, not parts of it. The badge is the sharp one -- an `<a href>`
 * floating over the bottom-right of the very asset area that advertises itself
 * as a drop target, on every deployment that has not turned the credit off.
 * Releasing a `.mov` a few pixels off it navigated the tab to `file:///...`
 * and took the session with it.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('next/navigation', () => ({ usePathname: () => '/projects/p1' }))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ fetchUser: vi.fn() }),
}))
vi.mock('@/stores/upload-store', () => ({
  useUploadStore: (select?: (s: object) => unknown) => {
    const state = { fetchHistory: vi.fn() }
    return select ? select(state) : state
  },
}))
vi.mock('@/components/layout/sidebar', () => ({
  Sidebar: () => <div data-testid="rail">rail</div>,
}))
vi.mock('@/components/layout/header', () => ({
  Header: () => <div data-testid="header">header</div>,
}))
vi.mock('@/components/layout/command-palette', () => ({ CommandPalette: () => null }))
vi.mock('@/components/layout/uploads-panel', () => ({ UploadsPanel: () => null }))
vi.mock('@/components/layout/upload-sse-bridge', () => ({ UploadSSEBridge: () => null }))
vi.mock('@/components/shared/powered-by-badge', () => ({
  PoweredByBadge: () => <a data-testid="badge" href="/">Powered by FreeFrame</a>,
}))

import DashboardLayout from '../layout'

const file = new File(['x'], 'cut-v3.mov', { type: 'video/quicktime' })
const fileDrag = () => ({ types: ['Files'], files: [file], dropEffect: 'none' })

function renderShell() {
  return render(
    <DashboardLayout>
      <div data-testid="page">the project page</div>
    </DashboardLayout>,
  )
}

describe('a file dropped on the dashboard shell', () => {
  // fireEvent returns false when the default was prevented, which is the only
  // thing standing between the drop and the browser loading the file.
  it.each([
    ['the attribution badge', 'badge'],
    ['the header', 'header'],
    ['the sidebar rail', 'rail'],
  ])('is refused on %s', (_name, testId) => {
    renderShell()
    const el = screen.getByTestId(testId)

    expect(fireEvent.dragOver(el, { dataTransfer: fileDrag() })).toBe(false)
    expect(fireEvent.drop(el, { dataTransfer: fileDrag() })).toBe(false)
  })

  it('says so to the pointer rather than only swallowing it', () => {
    renderShell()
    const dataTransfer = fileDrag()

    fireEvent.dragOver(screen.getByTestId('badge'), { dataTransfer })

    expect(dataTransfer.dropEffect).toBe('none')
  })

  it('is refused in the gap around the page as well', () => {
    // Not only on the named furniture: anything the shell holds and nothing
    // claimed ends up here.
    renderShell()

    expect(
      fireEvent.drop(screen.getByTestId('page'), { dataTransfer: fileDrag() }),
    ).toBe(false)
  })

  it('leaves an asset being dragged between folders alone', () => {
    // Item drags cross the shell constantly. Cancelling those would break
    // moving an asset into a folder, which predates all of this.
    renderShell()
    const dataTransfer = { types: ['application/json'], files: [], dropEffect: 'move' }

    expect(
      fireEvent.dragOver(screen.getByTestId('page'), { dataTransfer }),
    ).toBe(true)
    expect(dataTransfer.dropEffect).toBe('move')
  })
})
