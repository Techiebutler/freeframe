import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StorageBar, StorageUsage, StorageRing } from '../storage-usage'

function width(container: HTMLElement) {
  return (container.querySelector('[data-testid="storage-meter"] > div') as HTMLElement).style.width
}

describe('StorageBar', () => {
  // A 2 KB file next to a 90 GB master would otherwise have no bar at all,
  // which reads as "no storage" rather than "very little"; and a share that
  // overshoots is clamped rather than drawn outside its track.
  it.each([
    [25, '25%'],
    [0.01, '1%'],
    [0, '0%'],
    [140, '100%'],
  ])('draws %s%% of its track as %s', (pct, expected) => {
    expect(width(render(<StorageBar pct={pct} />).container)).toBe(expected)
  })

  it('is a labelled progressbar for assistive tech', () => {
    render(<StorageBar pct={40} label="Hero cut: 4 GB of 10 GB" />)
    const bar = screen.getByRole('progressbar', { name: 'Hero cut: 4 GB of 10 GB' })
    expect(bar).toHaveAttribute('aria-valuenow', '40')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
  })
})

describe('StorageUsage', () => {
  it('shows used-only, no meter, when unlimited (limit 0)', () => {
    const { container } = render(<StorageUsage used={500 * 1024 ** 2} limit={0} />)
    expect(screen.getByText(/Storage used/i)).toBeInTheDocument()
    expect(screen.getByText(/500 MB/)).toBeInTheDocument()
    expect(container.querySelector('[data-testid="storage-meter"]')).toBeNull()
  })

  it('shows used / limit and a meter when limited', () => {
    const { container } = render(<StorageUsage used={5 * 1024 ** 3} limit={10 * 1024 ** 3} />)
    expect(screen.getByText(/5 GB \/ 10 GB/)).toBeInTheDocument()
    expect(container.querySelector('[data-testid="storage-meter"]')).not.toBeNull()
  })
})

describe('StorageRing', () => {
  it('renders a progress ring with the percent in the center when a cap is set', () => {
    const { container, getByText } = render(<StorageRing used={5 * 1024 ** 3} limit={10 * 1024 ** 3} />)
    expect(container.querySelector('[data-testid="storage-ring"]')).not.toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
    expect(getByText('50')).toBeInTheDocument()  // 5 GB / 10 GB
  })

  it('renders a disk icon (no progress ring) when unlimited', () => {
    const { container } = render(<StorageRing used={5 * 1024 ** 3} limit={0} />)
    expect(container.querySelector('[data-testid="storage-ring-unlimited"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="storage-ring"]')).toBeNull()
  })
})
