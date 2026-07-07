import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('swr', () => {
  // Stable `data` reference across renders, mirroring real SWR's cache (a fresh object
  // each render would re-fire the component's [data] effect and clobber the input).
  const DATA = { storage_limit_bytes: 0, storage_used_bytes: 1024 ** 3 }
  return {
    default: () => ({ data: DATA, isLoading: false }),
    mutate: vi.fn(),
  }
})
const put = vi.fn().mockResolvedValue({})
vi.mock('@/lib/api', () => ({ api: { put: (...a: unknown[]) => put(...a) } }))

import { InstanceSettingsTab } from '../instance-settings-tab'

describe('InstanceSettingsTab', () => {
  beforeEach(() => put.mockClear())

  it('saves the GB input as bytes via PUT', async () => {
    render(<InstanceSettingsTab />)
    fireEvent.change(screen.getByLabelText(/storage limit/i), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/instance/settings', { storage_limit_bytes: 10 * 1024 ** 3 }),
    )
  })

  it('saves 0 (unlimited) when the input is blank', async () => {
    render(<InstanceSettingsTab />)
    fireEvent.change(screen.getByLabelText(/storage limit/i), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/instance/settings', { storage_limit_bytes: 0 }),
    )
  })
})
