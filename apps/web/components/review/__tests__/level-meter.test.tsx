import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { LevelMeter } from '../level-meter'
import { METER_COLUMNS, METER_ROWS } from '@/lib/level-meter'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function manualFrames() {
  let cb: FrameRequestCallback | null = null
  let t = 0
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { cb = f; return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => { cb = null })
  return { frame: (ms = 16) => { t += ms; const f = cb; cb = null; act(() => { f?.(t) }) }, pending: () => cb !== null }
}
const dot = (c: HTMLElement, col: number, row: number) => c.querySelectorAll('[data-testid="level-meter"] > div')[col].children[row] as HTMLElement

describe('LevelMeter', () => {
  it('draws columns x rows of dots, with silence as a calm centre line', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never
    manualFrames()
    const { container } = render(<LevelMeter levelRef={{ current: 0 }} />)
    expect(container.querySelectorAll('[data-testid="level-meter"] > div')).toHaveLength(METER_COLUMNS)
    expect(container.querySelectorAll('[data-testid="level-meter"] span')).toHaveLength(METER_COLUMNS * METER_ROWS)
    const centre = Math.floor(METER_ROWS / 2)
    expect(parseFloat(dot(container, METER_COLUMNS - 1, centre).style.opacity)).toBeGreaterThan(0.2)
    expect(parseFloat(dot(container, METER_COLUMNS - 1, 0).style.opacity)).toBeLessThan(0.2)
  })

  it('the newest column jumps with the voice within a couple of frames', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never
    const f = manualFrames()
    const level = { current: 0 }
    const { container } = render(<LevelMeter levelRef={level} />)
    const edge = () => parseFloat(dot(container, METER_COLUMNS - 1, 0).style.opacity)
    f.frame(); f.frame()
    const quiet = edge()
    level.current = 1
    f.frame(); f.frame(); f.frame()
    expect(edge()).toBeGreaterThan(quiet + 0.3)
  })

  it('loud peaks turn brand orange and quiet dots stay grey', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never
    const f = manualFrames()
    const level = { current: 1 }
    const { container } = render(<LevelMeter levelRef={level} />)
    for (let i = 0; i < 12; i++) f.frame()
    expect(dot(container, METER_COLUMNS - 1, 0).style.backgroundColor).toContain('--accent-hover')
    expect(dot(container, 0, 0).style.backgroundColor).not.toContain('--accent-hover')
  })

  it('older columns scroll left: a loud moment moves from the right edge towards the left', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never
    const f = manualFrames()
    const level = { current: 1 }
    const { container } = render(<LevelMeter levelRef={level} />)
    for (let i = 0; i < 12; i++) f.frame()
    level.current = 0
    for (let i = 0; i < 40; i++) f.frame()
    const op = (c: number) => parseFloat(dot(container, c, 0).style.opacity)
    expect(op(METER_COLUMNS - 1)).toBeLessThan(0.2)
    expect(Math.max(...Array.from({ length: METER_COLUMNS - 1 }, (_, c) => op(c)))).toBeGreaterThan(0.3)
  })

  it('is static under reduced motion: no animation frames at all', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never
    const f = manualFrames()
    render(<LevelMeter levelRef={{ current: 1 }} />)
    expect(f.pending()).toBe(false)
  })
})
