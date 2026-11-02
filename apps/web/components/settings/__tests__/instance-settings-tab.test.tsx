import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'

const GB = 1024 ** 3

const h = vi.hoisted(() => {
  // Controllable, STABLE `data` reference (mirrors real SWR's cache — a fresh object each
  // render would re-fire the component's effect and clobber the in-progress input).
  const DEFAULT = { storage_limit_bytes: 0, storage_used_bytes: 1024 ** 3 }
  return {
    DEFAULT,
    data: DEFAULT as
      | {
          storage_limit_bytes: number
          storage_used_bytes: number
          upload_part_size_bytes?: number
          allow_original_downloads?: boolean
          compression_level?: number | null
          compression_crf_offset?: number
          compression_level_effective?: number
        }
      | undefined,
  }
})
vi.mock('swr', () => ({
  default: () => ({ data: h.data, isLoading: false }),
  mutate: vi.fn(),
}))
const put = vi.fn().mockResolvedValue({})
vi.mock('@/lib/api', () => ({ api: { put: (...a: unknown[]) => put(...a) } }))

import { InstanceSettingsTab } from '../instance-settings-tab'
import { mutate } from 'swr'
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
const MB = 1024 ** 2
const partModeSelect = () => screen.getByLabelText(/upload part size/i) as HTMLSelectElement
const partSizeInput = () => screen.queryByLabelText(/part size \(mb\)/i) as HTMLInputElement | null
const originalsSelect = () => screen.getByLabelText(/outside a project/i) as HTMLSelectElement
// The step name is part of the label, which is where this app puts a slider's
// readout, so the accessible name is what names the step.
const compressionSlider = () => screen.getByLabelText(/^compression:/i) as HTMLInputElement
// Mirrors COMPRESSION_SAVE_DELAY_MS in the component; the one test that has to
// let the debounce run out rather than release the slider needs the number.
const COMPRESSION_SAVE_DELAY_MS = 250

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

  describe('upload part size', () => {
    it('is Automatic by default, with no size field', () => {
      render(<InstanceSettingsTab />)
      expect(partModeSelect()).toHaveValue('auto')
      expect(partSizeInput()).not.toBeInTheDocument()
      expect(screen.getByText(/sized from each file/i)).toBeInTheDocument()
    })

    it('saves the 10 MB default when switched to Fixed, and shows the field', async () => {
      // As SWR does: the saved settings become the cached data the tab renders.
      const saved = { ...h.DEFAULT, upload_part_size_bytes: 10 * MB }
      put.mockResolvedValue(saved)
      vi.mocked(mutate).mockImplementationOnce((() => {
        h.data = saved
      }) as never)
      render(<InstanceSettingsTab />)
      fireEvent.change(partModeSelect(), { target: { value: 'fixed' } })

      await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument())
      expect(put).toHaveBeenCalledWith('/instance/settings', { upload_part_size_bytes: 10 * MB })
      expect(partSizeInput()).toHaveValue(10)
    })

    it('saves 0 when switched back to Automatic', async () => {
      h.data = { ...h.DEFAULT, upload_part_size_bytes: 64 * MB }
      render(<InstanceSettingsTab />)
      expect(partModeSelect()).toHaveValue('fixed')
      expect(partSizeInput()).toHaveValue(64)

      fireEvent.change(partModeSelect(), { target: { value: 'auto' } })
      await waitFor(() =>
        expect(put).toHaveBeenCalledWith('/instance/settings', { upload_part_size_bytes: 0 }),
      )
    })

    it('saves a fixed size on blur only, in bytes', async () => {
      h.data = { ...h.DEFAULT, upload_part_size_bytes: 10 * MB }
      render(<InstanceSettingsTab />)
      fireEvent.change(partSizeInput()!, { target: { value: '1' } })
      fireEvent.change(partSizeInput()!, { target: { value: '12' } })
      fireEvent.change(partSizeInput()!, { target: { value: '128' } })
      expect(put).not.toHaveBeenCalled()

      fireEvent.blur(partSizeInput()!)
      await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument())
      expect(settingsPuts()).toEqual([['/instance/settings', { upload_part_size_bytes: 128 * MB }]])
    })

    it.each(['4', '513', '12.5'])('refuses %s MB without saving', (value) => {
      h.data = { ...h.DEFAULT, upload_part_size_bytes: 10 * MB }
      render(<InstanceSettingsTab />)
      fireEvent.change(partSizeInput()!, { target: { value } })
      fireEvent.blur(partSizeInput()!)

      expect(put).not.toHaveBeenCalled()
      expect(screen.getByText(/whole number of mb from 5 to 512/i)).toBeInTheDocument()
    })

    it('puts the saved size back when blurred blank', () => {
      h.data = { ...h.DEFAULT, upload_part_size_bytes: 64 * MB }
      render(<InstanceSettingsTab />)
      fireEvent.change(partSizeInput()!, { target: { value: '' } })
      fireEvent.blur(partSizeInput()!)

      expect(put).not.toHaveBeenCalled()
      expect(partSizeInput()).toHaveValue(64)
    })

    it('shows the error when the save fails', async () => {
      put.mockRejectedValue(new Error('storage settings unavailable'))
      render(<InstanceSettingsTab />)
      fireEvent.change(partModeSelect(), { target: { value: 'fixed' } })

      await waitFor(() =>
        expect(screen.getByText('storage settings unavailable')).toBeInTheDocument(),
      )
      expect(partModeSelect()).toHaveValue('auto')
    })

    it('is disabled until settings have loaded', () => {
      h.data = undefined
      render(<InstanceSettingsTab />)
      expect(partModeSelect()).toBeDisabled()
    })
  })

  describe('original downloads', () => {
    // Off by default: people outside a project get the transcode, as before.
    it('is Transcode only by default', () => {
      render(<InstanceSettingsTab />)
      expect(originalsSelect()).toHaveValue('transcode')
    })

    it('saves only this setting when changed', async () => {
      render(<InstanceSettingsTab />)
      fireEvent.change(originalsSelect(), { target: { value: 'original' } })

      await waitFor(() =>
        expect(put).toHaveBeenCalledWith('/instance/settings', { allow_original_downloads: true }),
      )
    })

    it('shows a saved setting', () => {
      h.data = { ...h.DEFAULT, allow_original_downloads: true }
      render(<InstanceSettingsTab />)
      expect(originalsSelect()).toHaveValue('original')
    })

    it('goes back to the saved value and shows the error when the save fails', async () => {
      put.mockRejectedValue(new Error('nope'))
      render(<InstanceSettingsTab />)
      fireEvent.change(originalsSelect(), { target: { value: 'original' } })

      await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument())
      expect(originalsSelect()).toHaveValue('transcode')
    })

    it('is disabled until settings have loaded', () => {
      h.data = undefined
      render(<InstanceSettingsTab />)
      expect(originalsSelect()).toBeDisabled()
    })
  })

  describe('compression', () => {
    // Level 3 is what the transcoder always did, so an instance that has never
    // touched this shows the middle of the slider. An instance configured only
    // through TRANSCODER_CRF_OFFSET has no stored level and the thumb still has
    // to land where the encoder is, from the step the server resolved. And -5
    // is nobody's step: rounding to the nearest would claim a setting the
    // instance does not have, so the control says what is actually in force.
    it.each([
      ['nothing configured', {}, '3', 'Compression: Balanced'],
      [
        'a chosen level',
        { compression_level: 1, compression_crf_offset: -8, compression_level_effective: 1 },
        '1',
        'Compression: Highest quality',
      ],
      [
        'an environment offset',
        { compression_crf_offset: -8, compression_level_effective: 1 },
        '1',
        'Compression: Highest quality',
      ],
      ['an offset no step names', { compression_crf_offset: -5 }, '3', 'Compression: Custom (env)'],
    ])('shows where the instance sits for %s', (_what, settings, value, name) => {
      h.data = { ...h.DEFAULT, ...settings }
      render(<InstanceSettingsTab />)
      expect(compressionSlider()).toHaveValue(value)
      expect(compressionSlider()).toHaveAccessibleName(name)
      // The step name, not the number: a screen reader otherwise reads "2",
      // "3", "4" while dragging, because the name only lives in the label and
      // the label is not re-announced on a value change.
      expect(compressionSlider()).toHaveAttribute('aria-valuetext', name.split(': ')[1])
    })

    // The whole point of the control, and what the obvious shape gets wrong:
    // disabling the input on the first change event makes the browser abort the
    // pointer drag and move focus to BODY, so one sweep moved one step and the
    // second arrow key was lost. jsdom reproduces neither, so what is pinned is
    // the cause (the input stays enabled and focused through the gesture, and
    // while the PUT it triggered is still unanswered) with the result (one PUT,
    // for the step it was let go on, and none before).
    it.each([
      ['a drag', () => fireEvent.pointerUp(compressionSlider())],
      ['arrow keys', () => fireEvent.keyUp(compressionSlider(), { key: 'ArrowLeft' })],
    ])('saves once on release of %s, and not before', async (_what, release) => {
      render(<InstanceSettingsTab />)
      compressionSlider().focus()

      for (const value of ['4', '5']) {
        fireEvent.change(compressionSlider(), { target: { value } })
        expect(compressionSlider()).not.toBeDisabled()
        expect(document.activeElement).toBe(compressionSlider())
      }
      expect(put).not.toHaveBeenCalled()

      release()
      // Synchronously, before the answer: the release flushed the debounce
      // instead of the test waiting it out, which is what makes the release
      // handlers load-bearing rather than decoration.
      expect(settingsPuts()).toEqual([['/instance/settings', { compression_level: 5 }]])
      expect(compressionSlider()).not.toBeDisabled()
      expect(document.activeElement).toBe(compressionSlider())

      await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument())
      expect(settingsPuts()).toHaveLength(1)
      expect(compressionSlider()).not.toBeDisabled()
    })

    // The window is the PUT round trip: deciding "nothing to save" against the
    // value from the API drops the step the admin released on, because that
    // value only changes when the answer arrives.
    it('saves the step released on when a drag goes out and comes back', async () => {
      const first = deferred()
      put.mockReturnValueOnce(first.promise)
      h.data = {
        ...h.DEFAULT,
        compression_level: 3,
        compression_crf_offset: 0,
        compression_level_effective: 3,
      }
      render(<InstanceSettingsTab />)

      fireEvent.change(compressionSlider(), { target: { value: '5' } })
      fireEvent.pointerUp(compressionSlider())
      expect(settingsPuts()).toHaveLength(1)

      fireEvent.change(compressionSlider(), { target: { value: '3' } })
      fireEvent.pointerUp(compressionSlider())
      expect(settingsPuts()[1]).toEqual(['/instance/settings', { compression_level: 3 }])

      first.resolve({ compression_level: 5, compression_level_effective: 5 })
      await waitFor(() => expect(settingsPuts()).toHaveLength(2))
    })

    // An environment offset no step names means the instance is on no step at
    // all, so the middle of the track is a position and not a saved value: the
    // note says moving the slider overrides the variable, and 3 to 4 to 3 in
    // one gesture is the shortest way to ask for the middle step.
    it('overrides an offset no step names in one gesture', () => {
      h.data = { ...h.DEFAULT, compression_crf_offset: -5 }
      render(<InstanceSettingsTab />)
      expect(compressionSlider()).toHaveValue('3')

      fireEvent.change(compressionSlider(), { target: { value: '4' } })
      fireEvent.change(compressionSlider(), { target: { value: '3' } })
      fireEvent.pointerUp(compressionSlider())

      expect(settingsPuts()).toEqual([['/instance/settings', { compression_level: 3 }]])
    })

    // A drag that pauses longer than the debounce has its save sent while the
    // finger is still down, so clearing the draft on the answer would snap the
    // thumb back to the step that was saved.
    it('keeps the thumb where the finger is when a save answers mid-drag', async () => {
      const first = deferred()
      put.mockReturnValueOnce(first.promise)
      vi.useFakeTimers()
      try {
        render(<InstanceSettingsTab />)
        fireEvent.change(compressionSlider(), { target: { value: '4' } })
        // The debounce runs out with no release: the paused drag.
        await act(async () => {
          vi.advanceTimersByTime(COMPRESSION_SAVE_DELAY_MS + 50)
        })
        expect(settingsPuts()).toHaveLength(1)

        fireEvent.change(compressionSlider(), { target: { value: '5' } })
        await act(async () => {
          first.resolve({ compression_level: 4, compression_level_effective: 4 })
        })

        expect(compressionSlider()).toHaveValue('5')
      } finally {
        vi.useRealTimers()
      }
    })

    // A slow first answer must not overwrite a step chosen after it. The guard
    // is a sequence number rather than `disabled`, precisely so the control
    // stays usable mid-gesture.
    it('ignores an answer a later save has already superseded', async () => {
      const first = deferred()
      const second = deferred()
      put.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      vi.mocked(mutate).mockClear()
      render(<InstanceSettingsTab />)

      fireEvent.change(compressionSlider(), { target: { value: '2' } })
      fireEvent.pointerUp(compressionSlider())
      await waitFor(() => expect(settingsPuts()).toHaveLength(1))
      fireEvent.change(compressionSlider(), { target: { value: '1' } })
      fireEvent.pointerUp(compressionSlider())
      await waitFor(() => expect(settingsPuts()).toHaveLength(2))

      second.resolve({ compression_level: 1, compression_level_effective: 1 })
      await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
      first.resolve({ compression_level: 2, compression_level_effective: 2 })
      await new Promise((r) => setTimeout(r, 0))
      expect(mutate).toHaveBeenCalledTimes(1)
    })

    it('goes back to the saved level and shows the error when the save fails', async () => {
      put.mockRejectedValueOnce(new Error('nope'))
      h.data = { ...h.DEFAULT, compression_level: 2, compression_level_effective: 2 }
      render(<InstanceSettingsTab />)

      fireEvent.change(compressionSlider(), { target: { value: '5' } })
      fireEvent.pointerUp(compressionSlider())

      await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument())
      expect(compressionSlider()).toHaveValue('2')
    })

    // Clearing the level is the only way back to TRANSCODER_CRF_OFFSET without
    // psql, so it has to send an explicit null rather than omit the key -- and
    // it is offered only once a level is stored.
    it('hands the instance back to the server default', async () => {
      const serverDefault = () => screen.queryByRole('button', { name: /use server default/i })
      const first = render(<InstanceSettingsTab />)
      expect(serverDefault()).not.toBeInTheDocument()
      first.unmount()

      h.data = { ...h.DEFAULT, compression_level: 1, compression_level_effective: 1 }
      render(<InstanceSettingsTab />)
      serverDefault()!.focus()
      fireEvent.click(serverDefault()!)

      await waitFor(() => expect(settingsPuts()).toHaveLength(1))
      expect(settingsPuts()).toEqual([['/instance/settings', { compression_level: null }]])
      // The button disappears the moment the level is cleared, so focus has to
      // be put somewhere: on the control it belongs to, not on the document.
      await waitFor(() => expect(document.activeElement).toBe(compressionSlider()))
    })
  })
})
