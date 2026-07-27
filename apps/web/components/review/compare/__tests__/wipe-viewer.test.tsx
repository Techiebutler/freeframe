import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, renderHook, act } from '@testing-library/react'
import { WipeViewer } from '../wipe-viewer'
import { useSharedTransform } from '../use-shared-transform'

function renderWipe() {
  const { result } = renderHook(() => useSharedTransform())
  render(
    <WipeViewer urlA="/a.webp" urlB="/b.webp" badgeA="v1" badgeB="v3" transform={result.current} />,
  )
  return result
}

describe('WipeViewer', () => {
  it('renders both images, badges, and starts split at 50%', () => {
    renderWipe()
    expect(screen.getByAltText('v1')).toHaveAttribute('src', '/a.webp')
    expect(screen.getByAltText('v3')).toHaveAttribute('src', '/b.webp')
    expect(screen.getByText('v1')).toBeInTheDocument()
    expect(screen.getByText('v3')).toBeInTheDocument()
    expect(screen.getByTestId('wipe-divider')).toHaveAttribute('data-split', '50')
  })

  it('divider drag updates the split percentage from pointer position', () => {
    renderWipe()
    const stage = screen.getByTestId('wipe-stage')
    stage.getBoundingClientRect = () =>
      ({ left: 0, width: 1000, top: 0, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    const divider = screen.getByTestId('wipe-divider')
    fireEvent.pointerDown(divider, { clientX: 500 })
    fireEvent.pointerMove(window, { clientX: 250 })
    fireEvent.pointerUp(window)
    expect(divider).toHaveAttribute('data-split', '25')
  })

  it('renders the overlay prop inside the stage, unclipped (outside the clipPath layer)', () => {
    const { result } = renderHook(() => useSharedTransform())
    render(
      <WipeViewer
        urlA="/a.webp" urlB="/b.webp" badgeA="v1" badgeB="v3"
        transform={result.current}
        overlay={<div data-testid="wipe-overlay" />}
      />,
    )
    const overlay = screen.getByTestId('wipe-overlay')
    expect(screen.getByTestId('wipe-stage')).toContainElement(overlay)
    // Unclipped: no ancestor between the overlay and the stage carries a clipPath.
    let node = overlay.parentElement
    while (node && node !== screen.getByTestId('wipe-stage')) {
      expect(node.style.clipPath).toBe('')
      node = node.parentElement
    }
  })

  it('clips the overlay to the owning version’s half (A left of the divider, B right)', () => {
    const { result } = renderHook(() => useSharedTransform())
    const { rerender } = render(
      <WipeViewer
        urlA="/a.webp" urlB="/b.webp" badgeA="v1" badgeB="v3"
        transform={result.current}
        overlay={<div data-testid="ov" />}
        overlaySide="a"
      />,
    )
    // Side A is visible LEFT of the divider (split defaults to 50%).
    expect(screen.getByTestId('wipe-overlay-clip').style.clipPath).toBe('inset(0 50% 0 0)')

    rerender(
      <WipeViewer
        urlA="/a.webp" urlB="/b.webp" badgeA="v1" badgeB="v3"
        transform={result.current}
        overlay={<div data-testid="ov" />}
        overlaySide="b"
      />,
    )
    // Side B is visible RIGHT of the divider — same clip as the B image layer.
    expect(screen.getByTestId('wipe-overlay-clip').style.clipPath).toBe('inset(0 0 0 50%)')
  })
})

describe('useSharedTransform', () => {
  it('zooms with wheel within [1, 8] and resets', () => {
    const { result } = renderHook(() => useSharedTransform())
    act(() => result.current.onWheel({ deltaY: -100, preventDefault() {} } as unknown as WheelEvent))
    expect(result.current.scale).toBeCloseTo(1.2)
    act(() => { for (let i = 0; i < 30; i++) result.current.onWheel({ deltaY: -100, preventDefault() {} } as unknown as WheelEvent) })
    expect(result.current.scale).toBeLessThanOrEqual(8)
    act(() => result.current.reset())
    expect(result.current.scale).toBe(1)
    expect(result.current.tx).toBe(0)
  })
})
