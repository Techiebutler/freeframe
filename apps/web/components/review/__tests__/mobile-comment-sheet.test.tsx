import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MobileCommentSheet, PEEK_PX, type SheetState } from '../mobile-comment-sheet'

// The sheet resolves `half`/`full` against its positioned ancestor's
// clientHeight, which jsdom reports as 0, so it falls back to
// window.innerHeight. Pin that to 800 and the snap heights are exact:
//   peek 56 · compose 220 · half round(800*0.55)=440 · full round(800*0.9)=720
function setViewportHeight(px: number) {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: px })
}

// jsdom implements neither window.visualViewport nor setPointerCapture.
function stubVisualViewport(height: number | null) {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value:
      height === null
        ? undefined
        : { height, offsetTop: 0, addEventListener: () => {}, removeEventListener: () => {} },
  })
}

// Mirrors real pointer-capture semantics (see progress-bar-pointer.test.tsx's
// `setupTrack`): `captured` tracks which pointer ids are actually held, and
// `releasePointerCapture` throws NotFoundError — as browsers do — when asked
// to release one that isn't. That throw is what makes an unguarded
// `releasePointerCapture` call in production reachable and test-visible,
// instead of silently no-op'ing like a plain `vi.fn()` would.
function capturePointer(el: HTMLElement) {
  const captured = new Set<number>()
  ;(el as any).setPointerCapture = vi.fn((id: number) => {
    captured.add(id)
  })
  ;(el as any).hasPointerCapture = vi.fn((id: number) => captured.has(id))
  ;(el as any).releasePointerCapture = vi.fn((id: number) => {
    if (!captured.has(id)) {
      throw new DOMException(
        "Failed to execute 'releasePointerCapture' on 'Element': The PointerEvent id provided is not in the set of captured pointers.",
        'NotFoundError',
      )
    }
    captured.delete(id)
  })
  return captured
}

function renderSheet(props: Partial<React.ComponentProps<typeof MobileCommentSheet>> = {}) {
  const onStateChange = vi.fn()
  const onHeightChange = vi.fn()
  const utils = render(
    <MobileCommentSheet
      state="peek"
      onStateChange={onStateChange}
      onHeightChange={onHeightChange}
      commentCount={3}
      isPlaying={false}
      onTogglePlay={vi.fn()}
      currentTime="00:01:23:04"
      lockedToCompose={false}
      composer={<div data-testid="composer-body" />}
      {...props}
    >
      <div data-testid="panel-body" />
    </MobileCommentSheet>,
  )
  return { ...utils, onStateChange, onHeightChange }
}

describe('MobileCommentSheet', () => {
  beforeEach(() => {
    setViewportHeight(800)
    stubVisualViewport(null)
  })
  afterEach(() => stubVisualViewport(null))

  it('starts at the state it is given', () => {
    const { rerender, onStateChange } = renderSheet({ state: 'peek' })
    expect(screen.getByTestId('mobile-comment-sheet')).toHaveAttribute('data-state', 'peek')
    expect(screen.getByTestId('mobile-comment-sheet')).toHaveStyle({ height: '56px' })
    expect(screen.queryByTestId('panel-body')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-body')).not.toBeInTheDocument()

    rerender(
      <MobileCommentSheet
        state="half"
        onStateChange={onStateChange}
        onHeightChange={vi.fn()}
        commentCount={3}
        isPlaying={false}
        onTogglePlay={vi.fn()}
        currentTime="00:01:23:04"
        lockedToCompose={false}
        composer={<div data-testid="composer-body" />}
      >
        <div data-testid="panel-body" />
      </MobileCommentSheet>,
    )
    expect(screen.getByTestId('mobile-comment-sheet')).toHaveStyle({ height: '440px' })
    expect(screen.getByTestId('panel-body')).toBeInTheDocument()
    expect(screen.getByTestId('composer-body')).toBeInTheDocument()
  })

  it('hides the mini transport at peek, where the real transport row is visible', () => {
    // The handle's play/timecode exists only because the sheet covers the
    // player's own transport row. At `peek` the review wrapper reserves a
    // 56px band (PEEK_PX) so that row is on screen and reachable — so showing
    // a second play button here stacks two identical controls directly on top
    // of each other, each with its own independently-updating clock.
    renderSheet({ state: 'peek', isPlaying: true })
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
    expect(screen.queryByText('00:01:23:04')).not.toBeInTheDocument()
    expect(screen.getByText('Comments · 3')).toBeInTheDocument()
  })

  it('shows the mini transport once the sheet covers the transport row', () => {
    for (const state of ['compose', 'half', 'full'] as const) {
      const { unmount } = renderSheet({ state, isPlaying: true })
      expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
      expect(screen.getByText('00:01:23:04')).toBeInTheDocument()
      unmount()
    }
  })

  it('omits the mini transport when currentTime is empty', () => {
    renderSheet({ state: 'half', currentTime: '' })
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument()
    expect(screen.getByText('Comments · 3')).toBeInTheDocument()
  })

  it('toggles peek <-> half when the handle is tapped', () => {
    const { onStateChange } = renderSheet({ state: 'peek' })
    const handle = screen.getByTestId('sheet-handle')
    capturePointer(handle)

    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientY: 402, pointerId: 1 })
    expect(onStateChange).toHaveBeenCalledWith('half')
  })

  it('toggles half -> peek when the handle is tapped', () => {
    const { onStateChange } = renderSheet({ state: 'half' })
    const handle = screen.getByTestId('sheet-handle')
    capturePointer(handle)

    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientY: 400, pointerId: 1 })
    expect(onStateChange).toHaveBeenCalledWith('peek')
  })

  it('drops the mini transport mid-drag, as soon as the sheet clears the row', () => {
    // The committed `state` lags the finger. Keying the transport off `state`
    // instead of the live `shown` leaves both play buttons on screen for the
    // whole downward gesture — the reported bug, still visible, just harder to
    // catch because it only exists while the pointer is down.
    renderSheet({ state: 'half', isPlaying: true })
    const handle = screen.getByTestId('sheet-handle')
    capturePointer(handle)

    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()

    fireEvent.pointerDown(handle, { clientY: 200, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 600, pointerId: 1 })
    // Still mid-gesture — no pointerup, so `state` is untouched at 'half'.
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()

    // And it comes back on the way up, before the gesture commits.
    fireEvent.pointerMove(handle, { clientY: 200, pointerId: 1 })
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('names the handle for a screen reader, count included', () => {
    // aria-label wins over name-from-content and `role="button"` is
    // children-presentational, so the `Comments · N` span is pruned — the count
    // has to be in the label or it is gone from the only comment affordance
    // below md.
    const { unmount } = renderSheet({ state: 'peek', commentCount: 3 })
    expect(screen.getByTestId('sheet-handle')).toHaveAttribute('aria-label', 'Comments panel, 3 comments')
    unmount()

    renderSheet({ state: 'peek', commentCount: 0 })
    expect(screen.getByTestId('sheet-handle')).toHaveAttribute('aria-label', 'Comments panel')
  })

  it('snaps to peek when dragged down from half', () => {
    const { onStateChange } = renderSheet({ state: 'half' })
    const handle = screen.getByTestId('sheet-handle')
    capturePointer(handle)

    fireEvent.pointerDown(handle, { clientY: 200, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 420, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 600, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientY: 600, pointerId: 1 })

    expect(onStateChange).toHaveBeenLastCalledWith('peek')
  })

  it('releases pointer capture safely on pointercancel and resets the drag state', () => {
    renderSheet({ state: 'half' })
    const handle = screen.getByTestId('sheet-handle')
    const captured = capturePointer(handle)

    fireEvent.pointerDown(handle, { clientY: 200, pointerId: 1 })
    expect(captured.has(1)).toBe(true)

    // By the time pointercancel fires, the browser has already implicitly
    // released capture (an OS gesture — edge-swipe-back, Control Center, the
    // notification shade — preempted the touch). Simulate that here so an
    // unguarded releasePointerCapture call in production would throw
    // NotFoundError, exactly as it would on a real phone.
    captured.delete(1)

    expect(() =>
      fireEvent.pointerCancel(handle, { clientY: 500, pointerId: 1 }),
    ).not.toThrow()

    // Drag state was cleared: a further pointermove must not resume the drag
    // (the sheet stays at its resting 'half' height, round(800*0.55)=440,
    // rather than following clientY as it would mid-drag).
    fireEvent.pointerMove(handle, { clientY: 700, pointerId: 1 })
    expect(screen.getByTestId('mobile-comment-sheet')).toHaveStyle({ height: '440px' })
  })

  it('collapses to peek on Escape', () => {
    const { onStateChange } = renderSheet({ state: 'half' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onStateChange).toHaveBeenCalledWith('peek')
  })

  it('ignores Escape while lockedToCompose — dropping to peek there strands the user in drawing mode', () => {
    // Every other exit is closed at that point: the chevron is `disabled` and
    // toggleOpen early-returns while locked, the parent only moves the sheet on
    // the FALLING edge of isDrawingMode, the player's Draw button is behind the
    // sheet, and CommentInput's "Exit drawing" is unrendered at peek. So the
    // Escape handler needs the same guard the other two paths already have.
    const { onStateChange } = renderSheet({ state: 'compose', lockedToCompose: true })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onStateChange).not.toHaveBeenCalled()
  })

  it('exports the peek height the consumers reserve as a bottom inset', () => {
    // The wrappers reserve this band with `pb-14` (3.5rem = 56px) so the sheet
    // never covers the transport row, and subtract it from the media shift.
    // Both are hard-coded against this constant; if it moves, they must too.
    expect(PEEK_PX).toBe(56)
  })

  it('reports its pixel height, and the peek height yields a zero media shift', () => {
    const { onHeightChange } = renderSheet({ state: 'peek' })
    expect(onHeightChange).toHaveBeenCalledWith(56)
    // The consumer's formula (plan header): max(0, (h - 60) / 2).
    expect(Math.max(0, (56 - 60) / 2)).toBe(0)
  })

  it('reports the half height so the consumer can shift the media', () => {
    const { onHeightChange } = renderSheet({ state: 'half' })
    expect(onHeightChange).toHaveBeenLastCalledWith(440)
  })

  it('cannot be dragged past compose while lockedToCompose', () => {
    const { onStateChange } = renderSheet({ state: 'compose', lockedToCompose: true })
    const handle = screen.getByTestId('sheet-handle')
    capturePointer(handle)

    fireEvent.pointerDown(handle, { clientY: 600, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientY: 100, pointerId: 1 })

    expect(onStateChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('mobile-comment-sheet')).toHaveStyle({ height: '220px' })
  })

  it('applies the on-screen keyboard height as `bottom`, not as a transform', () => {
    stubVisualViewport(500) // 800 layout - 500 visual = a 300px keyboard
    renderSheet({ state: 'compose' })
    const sheet = screen.getByTestId('mobile-comment-sheet')
    expect(sheet).toHaveStyle({ bottom: '300px' })
    expect(sheet.style.transform).toBe('')
  })

  it('sits at bottom: 0 with no visualViewport at all', () => {
    stubVisualViewport(null)
    renderSheet({ state: 'half' })
    expect(screen.getByTestId('mobile-comment-sheet')).toHaveStyle({ bottom: '0px' })
  })

  it('uses fixed positioning when asked, absolute by default', () => {
    const { unmount } = renderSheet({ state: 'peek' })
    expect(screen.getByTestId('mobile-comment-sheet').className).toContain('absolute')
    unmount()
    renderSheet({ state: 'peek', position: 'fixed' })
    expect(screen.getByTestId('mobile-comment-sheet').className).toContain('fixed')
  })
})
