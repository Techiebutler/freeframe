import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WatermarkOverlay } from '../review/watermark-overlay'
import type { WatermarkRender, WatermarkRenderBlock } from '@/types'

function block(overrides: Partial<WatermarkRenderBlock> = {}): WatermarkRenderBlock {
  return {
    text: 'viewer@example.com',
    x: 50,
    y: 50,
    size: 4,
    color: '#FFFFFF',
    opacity: 0.35,
    rotation: 0,
    shadow: false,
    scroll: false,
    tiled: false,
    ...overrides,
  }
}

function watermark(blocks: WatermarkRenderBlock[]): WatermarkRender {
  return { enabled: true, blocks }
}

describe('WatermarkOverlay', () => {
  it('renders nothing when watermark is null or undefined', () => {
    const { container: c1 } = render(<WatermarkOverlay watermark={null} />)
    expect(c1.firstChild).toBeNull()
    const { container: c2 } = render(<WatermarkOverlay watermark={undefined} />)
    expect(c2.firstChild).toBeNull()
  })

  it('renders nothing when disabled or empty', () => {
    const { container: c1 } = render(
      <WatermarkOverlay watermark={{ enabled: false, blocks: [block()] }} />,
    )
    expect(c1.firstChild).toBeNull()
    const { container: c2 } = render(
      <WatermarkOverlay watermark={{ enabled: true, blocks: [] }} />,
    )
    expect(c2.firstChild).toBeNull()
  })

  it('renders the resolved block text', () => {
    render(<WatermarkOverlay watermark={watermark([block()])} />)
    expect(screen.getByText('viewer@example.com')).toBeInTheDocument()
  })

  it('ignores pointer events so playback controls stay usable', () => {
    render(<WatermarkOverlay watermark={watermark([block()])} />)
    expect(screen.getByTestId('watermark-overlay').className).toContain(
      'pointer-events-none',
    )
  })

  it('applies position, rotation, color, and opacity styles', () => {
    render(
      <WatermarkOverlay
        watermark={watermark([
          block({ x: 25, y: 75, rotation: -30, color: '#FF0000', opacity: 0.5 }),
        ])}
      />,
    )
    const span = screen.getByText('viewer@example.com')
    expect(span.style.left).toBe('25%')
    expect(span.style.top).toBe('75%')
    expect(span.style.transform).toContain('rotate(-30deg)')
    expect(span.style.opacity).toBe('0.5')
  })

  it('applies a text shadow when shadow is set', () => {
    render(<WatermarkOverlay watermark={watermark([block({ shadow: true })])} />)
    expect(screen.getByText('viewer@example.com').style.textShadow).not.toBe('')
  })

  it('repeats tiled blocks across the grid', () => {
    render(<WatermarkOverlay watermark={watermark([block({ tiled: true })])} />)
    expect(screen.getAllByText('viewer@example.com')).toHaveLength(9)
  })

  it('wraps scrolling blocks in the animation class', () => {
    const { container } = render(
      <WatermarkOverlay watermark={watermark([block({ scroll: true })])} />,
    )
    expect(container.querySelector('.wm-scroll')).not.toBeNull()
  })

  it('renders every block in a multi-block template', () => {
    render(
      <WatermarkOverlay
        watermark={watermark([
          block({ text: 'viewer@example.com' }),
          block({ text: 'CONFIDENTIAL', y: 90 }),
        ])}
      />,
    )
    expect(screen.getByText('viewer@example.com')).toBeInTheDocument()
    expect(screen.getByText('CONFIDENTIAL')).toBeInTheDocument()
  })
})
