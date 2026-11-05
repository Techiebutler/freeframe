import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { InkLayer } from '../ink-layer'

afterEach(() => { cleanup(); vi.useRealTimers() })
const draw = (layer: HTMLElement) => {
  layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 400, right: 200, bottom: 400, x: 0, y: 0, toJSON: () => ({}) })
  fireEvent.pointerDown(layer, { clientX: 10, clientY: 10, pointerId: 1 })
  fireEvent.pointerMove(layer, { clientX: 80, clientY: 120, pointerId: 1 })
  fireEvent.pointerMove(layer, { clientX: 150, clientY: 200, pointerId: 1 })
  fireEvent.pointerUp(layer, { clientX: 150, clientY: 200, pointerId: 1 })
}
const strokes = (c: HTMLElement) => c.querySelectorAll('.ink-stroke')

describe('InkLayer persistence', () => {
  it('keeps a stroke fully visible while the video is paused, with no timer', () => {
    vi.useFakeTimers()
    const { getByTestId, container } = render(<InkLayer active playing={false} onStart={() => {}} onMark={() => {}} />)
    draw(getByTestId('ink-layer'))
    expect(strokes(container)).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(strokes(container)).toHaveLength(1)
    expect(container.querySelector('.ink-stroke')).not.toHaveAttribute('data-fading')
  })

  it('fades out when playback resumes and is gone a few hundred ms later', () => {
    vi.useFakeTimers()
    const { getByTestId, container, rerender } = render(<InkLayer active playing={false} onStart={() => {}} onMark={() => {}} />)
    draw(getByTestId('ink-layer'))
    rerender(<InkLayer active playing onStart={() => {}} onMark={() => {}} />)
    expect(container.querySelector('.ink-stroke')).toHaveAttribute('data-fading')
    act(() => { vi.advanceTimersByTime(300) })
    expect(strokes(container)).toHaveLength(0)
  })

  it('hides instantly under reduced motion', () => {
    vi.useFakeTimers()
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} }) as never
    const { getByTestId, container, rerender } = render(<InkLayer active playing={false} onStart={() => {}} onMark={() => {}} />)
    draw(getByTestId('ink-layer'))
    rerender(<InkLayer active playing onStart={() => {}} onMark={() => {}} />)
    act(() => { vi.advanceTimersByTime(1) })
    expect(strokes(container)).toHaveLength(0)
  })

  it('a replayed stroke stays until playback resumes, then fades', () => {
    vi.useFakeTimers()
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} }) as never
    const replay = { key: 1, marks: [{ k: 'stroke' as const, points: [[0, 0], [0.5, 0.5], [1, 1]] as [number, number][] }] }
    const { container, rerender } = render(<InkLayer active={false} playing={false} replay={replay} onStart={() => {}} onMark={() => {}} />)
    expect(strokes(container)).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(5000) })
    expect(strokes(container)).toHaveLength(1)
    rerender(<InkLayer active={false} playing replay={replay} onStart={() => {}} onMark={() => {}} />)
    act(() => { vi.advanceTimersByTime(300) })
    expect(strokes(container)).toHaveLength(0)
  })

  it('draws ONE continuous dark contour under all white chunks, so no seams', () => {
    const { getByTestId, container } = render(<InkLayer active playing={false} onStart={() => {}} onMark={() => {}} />)
    const layer = getByTestId('ink-layer')
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 400, right: 200, bottom: 400, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.pointerDown(layer, { clientX: 5, clientY: 5, pointerId: 1 })
    for (let i = 1; i <= 30; i++) fireEvent.pointerMove(layer, { clientX: 5 + i * 5, clientY: 5 + i * 10 + (i % 3) * 4, pointerId: 1 })
    fireEvent.pointerUp(layer, { clientX: 155, clientY: 305, pointerId: 1 })
    const g = container.querySelector('.ink-stroke')!
    expect(g.querySelectorAll('.ink-contour')).toHaveLength(1)
    expect(g.querySelectorAll('.ink-line').length).toBeGreaterThan(1)
    const kids = Array.from(g.children).map(c => c.getAttribute('class'))
    expect(kids[0]).toBe('ink-contour')
    const cw = parseFloat((g.querySelector('.ink-contour') as SVGElement).style.strokeWidth)
    g.querySelectorAll('.ink-line').forEach(l => expect(cw).toBeGreaterThan(parseFloat((l as SVGElement).style.strokeWidth)))
  })

  it('drawn strokes are smooth curves, not polylines', () => {
    const { getByTestId, container } = render(<InkLayer active playing={false} onStart={() => {}} onMark={() => {}} />)
    draw(getByTestId('ink-layer'))
    expect(container.querySelector('.ink-line')?.getAttribute('d')).toMatch(/Q/)
  })
})

describe('InkLayer timed replay', () => {
  const marks = [{ k: 'stroke' as const, points: [[0, 0], [0.2, 0.2], [0.4, 0.4], [0.6, 0.6]] as [number, number][], times: [0, 100, 300, 600], offset_ms: 0 }]
  const pointsOf = (c: HTMLElement) => (c.querySelector('.ink-line')?.getAttribute('d') ?? '')

  it('draws the replayed stroke at its original speed, then leaves it complete', () => {
    vi.useFakeTimers()
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} }) as never
    const { container } = render(<InkLayer active={false} playing={false} replay={{ key: 1, marks }} onStart={() => {}} onMark={() => {}} />)
    expect(container.querySelector('.ink-line')).toBeNull()
    act(() => { vi.advanceTimersByTime(150) })
    const early = pointsOf(container)
    expect(early).toBeTruthy()
    act(() => { vi.advanceTimersByTime(250) })
    const mid = pointsOf(container)
    expect(mid.length).toBeGreaterThan(early.length)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(pointsOf(container).length).toBeGreaterThanOrEqual(mid.length)
    expect(container.querySelectorAll('.ink-stroke')).toHaveLength(1)
  })

  it('shows the whole stroke at once under reduced motion', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} }) as never
    const { container } = render(<InkLayer active={false} playing={false} replay={{ key: 2, marks }} onStart={() => {}} onMark={() => {}} />)
    expect(container.querySelector('.ink-line')).not.toBeNull()
  })

  it('records a time for every point while drawing', () => {
    const onMark = vi.fn()
    const { getByTestId } = render(<InkLayer active playing={false} onStart={() => {}} onMark={onMark} />)
    draw(getByTestId('ink-layer'))
    const [, points, times] = onMark.mock.calls[0]
    expect(times).toHaveLength(points.length)
    expect(times[0]).toBe(0)
  })
})

describe('InkLayer never keeps drawing after the button is up', () => {
  const rect = (l: HTMLElement) => { l.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 400, right: 200, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }) }
  it('ends the stroke when the mouse moves with no button held (pointerup was missed)', () => {
    const onMark = vi.fn()
    const { getByTestId, container } = render(<InkLayer active playing={false} onStart={() => {}} onMark={onMark} />)
    const l = getByTestId('ink-layer'); rect(l)
    fireEvent.pointerDown(l, { clientX: 10, clientY: 10, pointerId: 1, pointerType: 'mouse', buttons: 1 })
    fireEvent.pointerMove(l, { clientX: 80, clientY: 120, pointerId: 1, pointerType: 'mouse', buttons: 1 })
    // the release happened elsewhere (pause button, timeline): the cursor now hovers back over the video
    fireEvent.pointerMove(l, { clientX: 150, clientY: 300, pointerId: 1, pointerType: 'mouse', buttons: 0 })
    fireEvent.pointerMove(l, { clientX: 190, clientY: 390, pointerId: 1, pointerType: 'mouse', buttons: 0 })
    expect(onMark).toHaveBeenCalledTimes(1)
    expect(onMark.mock.calls[0][1]).toHaveLength(2)
    expect(container.querySelector('[data-live]')).toBeNull()
  })

  it('ends the stroke when pointer capture is lost', () => {
    const onMark = vi.fn()
    const { getByTestId, container } = render(<InkLayer active playing={false} onStart={() => {}} onMark={onMark} />)
    const l = getByTestId('ink-layer'); rect(l)
    fireEvent.pointerDown(l, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(l, { clientX: 80, clientY: 120, pointerId: 1 })
    fireEvent.lostPointerCapture(l, { pointerId: 1 })
    expect(onMark).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-live]')).toBeNull()
  })
})
