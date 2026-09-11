/**
 * The floating attribution badge must not render on the asset viewer.
 *
 * It is `fixed` in the bottom-right corner of the whole dashboard at 173x30,
 * and the asset viewer puts the comment composer's 28x28 send button in that
 * same corner. The badge is an `<a href>` and won it outright:
 * `elementsFromPoint` at the button's own centre returned the badge's span and
 * anchor above the button, so every click on Send opened the repository in a
 * new tab and the comment was never posted. Enter still posted it, which is
 * why this shipped in #264 and went unnoticed until #356.
 *
 * The viewer renders its own credit centred in its top bar, so gating here
 * removes a duplicate rather than dropping the attribution -- and both copies
 * read the same branding flag, so an admin who turns the credit off still
 * loses it everywhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

let pathname = '/projects/p1'

vi.mock('next/navigation', () => ({ usePathname: () => pathname }))
vi.mock('@/stores/auth-store', () => ({ useAuthStore: () => ({ fetchUser: vi.fn() }) }))
vi.mock('@/stores/upload-store', () => ({ useUploadStore: () => ({ fetchHistory: vi.fn() }) }))
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => <div>rail</div> }))
vi.mock('@/components/layout/header', () => ({
  Header: () => <div data-testid="header">header</div>,
}))
vi.mock('@/components/layout/command-palette', () => ({ CommandPalette: () => null }))
vi.mock('@/components/layout/uploads-panel', () => ({ UploadsPanel: () => null }))
vi.mock('@/components/layout/upload-sse-bridge', () => ({ UploadSSEBridge: () => null }))
vi.mock('@/components/shared/powered-by-badge', () => ({
  PoweredByBadge: () => <a data-testid="floating-badge" href="/">Powered by FreeFrame</a>,
}))

import DashboardLayout from '../layout'

function renderAt(path: string) {
  pathname = path
  return render(
    <DashboardLayout>
      <div>page</div>
    </DashboardLayout>,
  )
}

beforeEach(() => { pathname = '/projects/p1' })

describe('the floating attribution badge', () => {
  it('is not rendered on an asset viewer route, where it covered the send button', () => {
    renderAt('/projects/6f1e/assets/a42')

    expect(screen.queryByTestId('floating-badge')).toBeNull()
  })

  it('still renders on an ordinary dashboard route', () => {
    // The gate has to be the asset route specifically. Dropping the badge from
    // the whole shell would remove the credit from every other page.
    renderAt('/projects/p1')

    expect(screen.getByTestId('floating-badge')).toBeTruthy()
  })

  it('is gated by the same condition that replaces the header', () => {
    // Both come from `isAssetViewer`. If they ever diverge, the viewer would
    // show a header it already draws itself, or lose its credit entirely.
    renderAt('/projects/6f1e/assets/a42')
    expect(screen.queryByTestId('header')).toBeNull()
    expect(screen.queryByTestId('floating-badge')).toBeNull()
  })

  it('is not fooled by a project route that merely mentions assets', () => {
    // The regex needs a real `/assets/<id>` segment pair, not the word.
    renderAt('/projects/my-assets-archive')

    expect(screen.getByTestId('floating-badge')).toBeTruthy()
  })
})
