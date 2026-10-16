import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'

const get = vi.fn()
const patch = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: vi.fn(),
  },
}))

import { ShareLinkSettingsPanel } from '../share-link-detail'

describe('ShareLinkSettingsPanel expiry', () => {
  let savedTZ: string | undefined
  beforeEach(() => {
    savedTZ = process.env.TZ
    process.env.TZ = 'America/New_York'
    expect(new Date(2026, 9, 20, 12).getTimezoneOffset()).toBe(240)
    get.mockReset().mockResolvedValue({
      id: 'l1', token: 'tok', title: 'Link', permission: 'comment', visibility: 'public',
      allow_download: false, show_versions: true, show_watermark: false, is_enabled: true,
      has_password: false, appearance: {}, created_at: '2026-10-01T00:00:00Z',
      // End of 2026-10-20 in New York.
      expires_at: '2026-10-21T03:59:59.999Z',
    })
    patch.mockReset().mockResolvedValue({})
  })
  afterEach(() => {
    if (savedTZ === undefined) delete process.env.TZ
    else process.env.TZ = savedTZ
  })

  it('shows the stored day and saves a picked day as its end, local time', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ShareLinkSettingsPanel token="tok" />
      </SWRConfig>,
    )
    const input = await waitFor(() => {
      const el = document.querySelector('input[type="date"]') as HTMLInputElement | null
      expect(el).not.toBeNull()
      return el!
    })
    expect(input.value).toBe('2026-10-20')

    fireEvent.change(input, { target: { value: '2026-10-21' } })
    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect(patch.mock.calls[0]).toEqual(['/share/tok', { expires_at: '2026-10-22T03:59:59.999Z' }])
  })
})
