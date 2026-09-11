/**
 * The share tree refuses a file drag the same way the dashboard shell does
 * (see `(dashboard)/__tests__/layout-file-drag.test.tsx`).
 *
 * A share link has no drop target anywhere below this — folder-based upload
 * is disabled in share mode — so a file dragged in from outside the browser
 * always reaches here unclaimed. Left alone it navigates the tab to
 * `file:///...`, which costs a guest more than it costs a signed-in user:
 * there is no session to come back to, and any comment they had typed goes
 * with the page.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ShareLayout from '../layout'

const file = new File(['x'], 'notes.mov', { type: 'video/quicktime' })
const fileDrag = () => ({ types: ['Files'], files: [file], dropEffect: 'none' })

function renderShell() {
  return render(
    <ShareLayout>
      <div data-testid="page">the share page</div>
    </ShareLayout>,
  )
}

describe('a file dropped on the share tree', () => {
  it('is refused', () => {
    renderShell()

    expect(
      fireEvent.dragOver(screen.getByTestId('page'), { dataTransfer: fileDrag() }),
    ).toBe(false)
    expect(
      fireEvent.drop(screen.getByTestId('page'), { dataTransfer: fileDrag() }),
    ).toBe(false)
  })

  it('says so to the pointer rather than only swallowing it', () => {
    renderShell()
    const dataTransfer = fileDrag()

    fireEvent.dragOver(screen.getByTestId('page'), { dataTransfer })

    expect(dataTransfer.dropEffect).toBe('none')
  })

  it('leaves a non-file drag alone', () => {
    // Nothing in the share tree currently drags anything itself, but the
    // refusal is keyed on carrying files rather than on being unclaimed, so
    // it should not need to change if that ever stops being true.
    renderShell()
    const dataTransfer = { types: ['application/json'], files: [], dropEffect: 'move' }

    expect(
      fireEvent.dragOver(screen.getByTestId('page'), { dataTransfer }),
    ).toBe(true)
    expect(dataTransfer.dropEffect).toBe('move')
  })
})
