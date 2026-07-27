import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CompareScrubber } from '../compare-scrubber'

const base = {
  t: 10, total: 63, isPlaying: false, fps: 25,
  onToggle: vi.fn(), onSeek: vi.fn(), onMarkerClick: vi.fn(), onOffsetChange: vi.fn(),
  labelA: 'v1', labelB: 'v2', onResetOffsets: vi.fn(),
  markersA: [{ id: 'c1', tc: 10, authorName: 'Maya Chen', body: 'Looks great, nice color grade here', hasAnnotation: false }],
  markersB: [{ id: 'c2', tc: 4, authorName: 'Sam', body: 'Audio is a bit low', hasAnnotation: false }],
  timingA: { offset: 2, duration: 60 }, timingB: { offset: 0, duration: 61 },
}

describe('CompareScrubber', () => {
  it('shows SMPTE timecode for the transport time', () => {
    render(<CompareScrubber {...base} />)
    expect(screen.getByText('00:00:10:00')).toBeInTheDocument()
  })

  it('click on the track seeks by ratio', () => {
    render(<CompareScrubber {...base} />)
    const track = screen.getByTestId('compare-track')
    track.getBoundingClientRect = () =>
      ({ left: 0, width: 630, top: 0, height: 8, right: 630, bottom: 8, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    fireEvent.click(track, { clientX: 63 })
    expect(base.onSeek).toHaveBeenCalledWith((63 / 630) * 63)
  })

  it('positions markers at (tc + offset) / total and reports clicks per side', () => {
    render(<CompareScrubber {...base} />)
    const a = screen.getByTestId('marker-a-c1')
    expect(a.style.left).toBe(`${((10 + 2) / 63) * 100}%`)
    fireEvent.click(a)
    expect(base.onMarkerClick).toHaveBeenCalledWith('a', expect.objectContaining({ id: 'c1', tc: 10 }))
  })

  it('offset steppers nudge by one frame and one second, never below 0', () => {
    render(<CompareScrubber {...base} />)
    fireEvent.click(screen.getByTestId('offA-plus-frame'))
    expect(base.onOffsetChange).toHaveBeenCalledWith('a', 2.04)
    fireEvent.click(screen.getByTestId('offB-minus-second'))
    expect(base.onOffsetChange).toHaveBeenCalledWith('b', 0)
  })

  it('labels the offset rows with the version numbers, not A/B', () => {
    render(<CompareScrubber {...base} />)
    expect(screen.getByText('v1')).toBeInTheDocument()
    expect(screen.getByText('v2')).toBeInTheDocument()
    expect(screen.queryByText('A')).not.toBeInTheDocument()
    expect(screen.queryByText('B')).not.toBeInTheDocument()
  })

  it('reset button re-syncs offsets and disables when both are already 0', () => {
    const onResetOffsets = vi.fn()
    const { rerender } = render(<CompareScrubber {...base} onResetOffsets={onResetOffsets} />)
    const reset = screen.getByTestId('offset-reset')
    expect(reset).not.toBeDisabled() // base has side A offset = 2
    fireEvent.click(reset)
    expect(onResetOffsets).toHaveBeenCalledTimes(1)

    rerender(
      <CompareScrubber
        {...base}
        onResetOffsets={onResetOffsets}
        timingA={{ offset: 0, duration: 60 }}
        timingB={{ offset: 0, duration: 61 }}
      />,
    )
    expect(screen.getByTestId('offset-reset')).toBeDisabled()
  })

  it('shows author initials inside the marker dot', () => {
    render(<CompareScrubber {...base} />)
    const a = screen.getByTestId('marker-a-c1')
    expect(a.textContent).toContain('MC')
  })

  it('shows a hover tooltip with author name and body, hidden on mouse leave', () => {
    render(<CompareScrubber {...base} />)
    const a = screen.getByTestId('marker-a-c1')
    expect(screen.queryByText('Maya Chen')).not.toBeInTheDocument()

    fireEvent.mouseEnter(a)
    expect(screen.getByText('Maya Chen')).toBeInTheDocument()
    expect(screen.getByText(/Looks great/)).toBeInTheDocument()

    fireEvent.mouseLeave(a)
    expect(screen.queryByText('Maya Chen')).not.toBeInTheDocument()
  })
})
