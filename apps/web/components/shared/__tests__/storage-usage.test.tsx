import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StorageUsage, StorageRing } from '../storage-usage'

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
