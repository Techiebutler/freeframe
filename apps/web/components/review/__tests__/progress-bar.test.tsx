import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { ProgressBar } from '../progress-bar'

describe('ProgressBar scrubbing', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 4,
      width: 200,
      height: 4,
      x: 0,
      y: 0,
      toJSON() {},
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('seeks on pointerdown, tracks the drag on pointermove, and finalizes on pointerup', () => {
    const onSeek = vi.fn()
    const { getByTestId } = render(<ProgressBar currentTime={0} duration={100} onSeek={onSeek} />)
    const track = getByTestId('progress-bar-track')

    fireEvent.pointerDown(track, { pointerId: 1, clientX: 20, isPrimary: true, button: 0 })
    expect(onSeek).toHaveBeenLastCalledWith(10) // 20/200 * 100

    fireEvent.pointerMove(track, { pointerId: 1, clientX: 60 })
    expect(onSeek).toHaveBeenLastCalledWith(30) // 60/200 * 100

    fireEvent.pointerUp(track, { pointerId: 1, clientX: 100 })
    expect(onSeek).toHaveBeenLastCalledWith(50) // 100/200 * 100
    expect(onSeek).toHaveBeenCalledTimes(3)
  })

  it('ignores a second pointer while dragging, so a two-finger grip cannot hijack the seek', () => {
    const onSeek = vi.fn()
    const { getByTestId } = render(<ProgressBar currentTime={0} duration={100} onSeek={onSeek} />)
    const track = getByTestId('progress-bar-track')

    fireEvent.pointerDown(track, { pointerId: 1, clientX: 20, isPrimary: true, button: 0 })
    onSeek.mockClear()

    // A second finger lifting/moving over the track must not affect the drag.
    fireEvent.pointerMove(track, { pointerId: 2, clientX: 190 })
    expect(onSeek).not.toHaveBeenCalled()
    fireEvent.pointerUp(track, { pointerId: 2, clientX: 190 })
    expect(onSeek).not.toHaveBeenCalled()

    // The original pointer still drives the drag.
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 60 })
    expect(onSeek).toHaveBeenLastCalledWith(30)
  })

  it('ends the drag on pointercancel, so a later move on the page does not keep seeking', () => {
    const onSeek = vi.fn()
    const { getByTestId } = render(<ProgressBar currentTime={0} duration={100} onSeek={onSeek} />)
    const track = getByTestId('progress-bar-track')

    fireEvent.pointerDown(track, { pointerId: 1, clientX: 20, isPrimary: true, button: 0 })
    fireEvent.pointerCancel(track, { pointerId: 1 })
    onSeek.mockClear()

    fireEvent.pointerMove(track, { pointerId: 1, clientX: 150 })
    expect(onSeek).not.toHaveBeenCalled()

    // A fresh pointer can start a new drag afterwards.
    fireEvent.pointerDown(track, { pointerId: 3, clientX: 100, isPrimary: true, button: 0 })
    expect(onSeek).toHaveBeenLastCalledWith(50)
  })

  it('ignores a non-primary pointer (e.g. a second simultaneous touch) on pointerdown', () => {
    const onSeek = vi.fn()
    const { getByTestId } = render(<ProgressBar currentTime={0} duration={100} onSeek={onSeek} />)
    const track = getByTestId('progress-bar-track')

    fireEvent.pointerDown(track, { pointerId: 1, clientX: 20, isPrimary: false, button: 0 })
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('ignores a non-primary-button press (e.g. right-click) on pointerdown', () => {
    const onSeek = vi.fn()
    const { getByTestId } = render(<ProgressBar currentTime={0} duration={100} onSeek={onSeek} />)
    const track = getByTestId('progress-bar-track')

    fireEvent.pointerDown(track, { pointerId: 1, clientX: 20, isPrimary: true, button: 2 })
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('ends the drag on onLostPointerCapture, so the bar is never permanently latched', () => {
    const onSeek = vi.fn()
    const { getByTestId } = render(<ProgressBar currentTime={0} duration={100} onSeek={onSeek} />)
    const track = getByTestId('progress-bar-track')

    fireEvent.pointerDown(track, { pointerId: 1, clientX: 20, isPrimary: true, button: 0 })
    // Capture is lost without a matching pointerup/pointercancel ever reaching
    // the track (e.g. the release genuinely happened somewhere else) — this is
    // the only remaining way to end the drag in that case.
    fireEvent(track, new Event('lostpointercapture', { bubbles: true }))
    onSeek.mockClear()

    // The bar must still respond to a fresh press — a stuck latch here would
    // make it permanently dead for the life of the mounted component.
    fireEvent.pointerDown(track, { pointerId: 2, clientX: 100, isPrimary: true, button: 0 })
    expect(onSeek).toHaveBeenLastCalledWith(50)
  })

  it('clamps the hover tooltip to the track bounds during a captured drag past the edge', () => {
    const onSeek = vi.fn()
    const { getByTestId } = render(<ProgressBar currentTime={0} duration={100} onSeek={onSeek} />)
    const track = getByTestId('progress-bar-track')

    fireEvent.pointerDown(track, { pointerId: 1, clientX: 20, isPrimary: true, button: 0 })
    // Pointer capture means this can keep arriving well outside the track's
    // own [0, 200] bounds — the seek is already clamped via getTimeFromEvent,
    // but the floating tooltip has its own, separate positioning.
    fireEvent.pointerMove(track, { pointerId: 1, clientX: -300 })

    const tooltip = getByTestId('progress-bar-hover-tooltip')
    expect(tooltip.style.left).toBe('0px')

    fireEvent.pointerMove(track, { pointerId: 1, clientX: 500 })
    expect(tooltip.style.left).toBe('200px')
  })
})
