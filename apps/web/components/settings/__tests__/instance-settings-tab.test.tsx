import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const GB = 1024 ** 3

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

function deferred<T = unknown>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const limitInput = () => screen.getByLabelText(/storage limit/i) as HTMLInputElement
const modeSelect = () => screen.getByLabelText(/default sign-in method/i) as HTMLSelectElement
const settingsPuts = () => put.mock.calls.filter(([url]) => url === '/instance/settings')

describe('InstanceSettingsTab', () => {
  beforeEach(() => {
    put.mockReset()
    put.mockResolvedValue({})
    h.data = h.DEFAULT
    useBrandingStore.setState({ loaded: true, defaultLoginMode: 'magic_code' })
  })

  it('has no Save button: each setting saves on its own', () => {
    render(<InstanceSettingsTab />)
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
  })

  describe('sign-in method', () => {
    it('saves on change, sending only the sign-in method', async () => {
      render(<InstanceSettingsTab />)
      fireEvent.change(modeSelect(), { target: { value: 'password' } })

      await waitFor(() => expect(useBrandingStore.getState().defaultLoginMode).toBe('password'))
      expect(put).toHaveBeenCalledTimes(1)
      expect(put).toHaveBeenCalledWith('/instance/branding', { default_login_mode: 'password' })
      expect(screen.getByText('Saved')).toBeInTheDocument()
    })

    it('shows the new value and stays disabled while the save is in flight', async () => {
      const d = deferred()
      put.mockReturnValue(d.promise)
      render(<InstanceSettingsTab />)
      fireEvent.change(modeSelect(), { target: { value: 'password' } })

      expect(modeSelect()).toHaveValue('password')
      expect(modeSelect()).toBeDisabled()

      d.resolve({})
      await waitFor(() => expect(modeSelect()).not.toBeDisabled())
      expect(modeSelect()).toHaveValue('password')
    })

    it('reverts to the saved value and shows the error when the save fails', async () => {
      put.mockRejectedValue(new Error('nope'))
      render(<InstanceSettingsTab />)
      fireEvent.change(modeSelect(), { target: { value: 'password' } })

      await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument())
      expect(modeSelect()).toHaveValue('magic_code')
      expect(modeSelect()).not.toBeDisabled()
      expect(useBrandingStore.getState().defaultLoginMode).toBe('magic_code')
      expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    })

    it('is disabled until branding has loaded', () => {
      useBrandingStore.setState({ loaded: false, fetchBranding: vi.fn() })
      render(<InstanceSettingsTab />)
      expect(modeSelect()).toBeDisabled()
    })
  })

  describe('storage limit', () => {
    it('makes no PUT while typing, and exactly one on blur', async () => {
      render(<InstanceSettingsTab />)
      fireEvent.change(limitInput(), { target: { value: '1' } })
      fireEvent.change(limitInput(), { target: { value: '10' } })
      fireEvent.change(limitInput(), { target: { value: '100' } })
      expect(put).not.toHaveBeenCalled()

      fireEvent.blur(limitInput())
      await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument())
      expect(put).toHaveBeenCalledTimes(1)
      expect(put).toHaveBeenCalledWith('/instance/settings', { storage_limit_bytes: 100 * GB })
    })

    it('saves once when Enter is followed by blur', async () => {
      render(<InstanceSettingsTab />)
      const input = limitInput()
      input.focus()
      fireEvent.change(input, { target: { value: '10' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      fireEvent.blur(input)

      await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument())
      expect(settingsPuts()).toHaveLength(1)
    })

    it('makes no PUT when the value has not changed', () => {
      h.data = { storage_limit_bytes: 5 * GB, storage_used_bytes: GB }
      render(<InstanceSettingsTab />)
      expect(limitInput()).toHaveValue(5)

      fireEvent.blur(limitInput())
      fireEvent.change(limitInput(), { target: { value: '5.0' } })
      fireEvent.blur(limitInput())
      expect(put).not.toHaveBeenCalled()
    })

    it('puts the saved value back when blurred blank, instead of sending 0', () => {
      h.data = { storage_limit_bytes: 5 * GB, storage_used_bytes: GB }
      render(<InstanceSettingsTab />)
      fireEvent.change(limitInput(), { target: { value: '' } })
      fireEvent.blur(limitInput())

      expect(put).not.toHaveBeenCalled()
      expect(limitInput()).toHaveValue(5)
    })

    it('saves an explicit 0 as unlimited', async () => {
      h.data = { storage_limit_bytes: 5 * GB, storage_used_bytes: GB }
      render(<InstanceSettingsTab />)
      fireEvent.change(limitInput(), { target: { value: '0' } })
      fireEvent.blur(limitInput())

      await waitFor(() =>
        expect(put).toHaveBeenCalledWith('/instance/settings', { storage_limit_bytes: 0 }),
      )
    })

    it('rejects text the number input cannot parse (reported as "")', () => {
      h.data = { storage_limit_bytes: 5 * GB, storage_used_bytes: GB }
      render(<InstanceSettingsTab />)
      const input = limitInput()
      fireEvent.change(input, { target: { value: '' } })
      // jsdom never sets badInput, so stand in for a browser holding "1e".
      Object.defineProperty(input, 'validity', { value: { badInput: true }, configurable: true })
      fireEvent.blur(input)

      expect(put).not.toHaveBeenCalled()
      expect(screen.getByText(/enter a number of gb/i)).toBeInTheDocument()
    })

    it('rejects a positive value too small to be a whole byte', () => {
      render(<InstanceSettingsTab />)
      fireEvent.change(limitInput(), { target: { value: '0.0000000001' } })
      fireEvent.blur(limitInput())

      expect(put).not.toHaveBeenCalled()
      expect(screen.getByText(/too small/i)).toBeInTheDocument()
    })

    it('shows the error under the input when the save fails', async () => {
      put.mockRejectedValue(new Error('quota service down'))
      render(<InstanceSettingsTab />)
      fireEvent.change(limitInput(), { target: { value: '10' } })
      fireEvent.blur(limitInput())

      await waitFor(() => expect(screen.getByText('quota service down')).toBeInTheDocument())
      expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    })

    it('is disabled until settings have loaded (so a pre-load blur cannot save over a cap)', () => {
      h.data = undefined
      render(<InstanceSettingsTab />)
      expect(limitInput()).toBeDisabled()
    })
  })
})
