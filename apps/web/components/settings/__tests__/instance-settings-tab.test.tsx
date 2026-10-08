import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => {
  // Controllable, STABLE `data` reference (mirrors real SWR's cache — a fresh object each
  // render would re-fire the component's effect and clobber the in-progress input).
  const DEFAULT = { storage_limit_bytes: 0, storage_used_bytes: 1024 ** 3 }
  return { DEFAULT, data: DEFAULT as { storage_limit_bytes: number; storage_used_bytes: number } | undefined }
})
vi.mock('swr', () => ({
  default: () => ({ data: h.data, isLoading: false }),
  mutate: vi.fn(),
}))
const put = vi.fn().mockResolvedValue({})
vi.mock('@/lib/api', () => ({ api: { put: (...a: unknown[]) => put(...a) } }))

import { InstanceSettingsTab } from '../instance-settings-tab'
import { useBrandingStore } from '@/stores/branding-store'

describe('InstanceSettingsTab', () => {
  beforeEach(() => {
    put.mockReset()
    put.mockResolvedValue({})
    h.data = h.DEFAULT
    useBrandingStore.setState({ loaded: true, defaultLoginMode: 'magic_code' })
  })

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

  it('disables Save until settings have loaded (so a pre-load click cannot PUT 0 and wipe a cap)', () => {
    h.data = undefined
    render(<InstanceSettingsTab />)
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })

  it('saves the sign-in method with the Save button, to branding where the login page reads it', async () => {
    render(<InstanceSettingsTab />)
    const select = screen.getByLabelText(/default sign-in method/i)
    expect(select).toHaveValue('magic_code')

    fireEvent.change(select, { target: { value: 'password' } })
    expect(put).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/instance/branding', { default_login_mode: 'password' }),
    )
    expect(put).toHaveBeenCalledWith('/instance/settings', expect.any(Object))
    await waitFor(() => expect(useBrandingStore.getState().defaultLoginMode).toBe('password'))
    expect(screen.getByText('Saved.')).toBeInTheDocument()
  })

  it('leaves the sign-in method alone when it was not changed', async () => {
    render(<InstanceSettingsTab />)
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(screen.getByText('Saved.')).toBeInTheDocument())
    expect(put).not.toHaveBeenCalledWith('/instance/branding', expect.anything())
  })

  it('still saves the storage limit when the sign-in method fails, and says which failed', async () => {
    put.mockImplementation((url: string) =>
      url === '/instance/branding' ? Promise.reject(new Error('nope')) : Promise.resolve({}),
    )
    render(<InstanceSettingsTab />)
    fireEvent.change(screen.getByLabelText(/default sign-in method/i), { target: { value: 'password' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(screen.getByText(/sign-in method: nope/i)).toBeInTheDocument())
    expect(put).toHaveBeenCalledWith('/instance/settings', expect.any(Object))
    expect(useBrandingStore.getState().defaultLoginMode).toBe('magic_code')
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument()
  })

  it('disables the sign-in method and Save until branding has loaded', () => {
    useBrandingStore.setState({ loaded: false, fetchBranding: vi.fn() })
    render(<InstanceSettingsTab />)
    expect(screen.getByLabelText(/default sign-in method/i)).toBeDisabled()
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })
})
