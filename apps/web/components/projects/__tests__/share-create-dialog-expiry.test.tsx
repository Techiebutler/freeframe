import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const post = vi.fn()
const patch = vi.fn()
const get = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
  },
}))

import { ShareCreateDialog } from '../share-create-dialog'

// 2026-10-20 in New York (EDT, UTC-4) ends at 03:59:59.999 UTC on the 21st.
const NY_END_OF_OCT_20 = '2026-10-21T03:59:59.999Z'

function renderDialog(items: { type: 'asset' | 'folder'; id: string; name: string }[]) {
  return render(
    <ShareCreateDialog
      open
      onOpenChange={() => {}}
      projectId="p1"
      currentFolderId={null}
      assets={[]}
      folders={[]}
      preselectedItems={items}
      onShareCreated={() => {}}
    />,
  )
}

function pickExpiryAndCreate(date: string) {
  const input = document.querySelector('input[type="date"]') as HTMLInputElement
  fireEvent.change(input, { target: { value: date } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
}

/** Every expires_at the dialog sent, in any request. */
function sentExpiries(): unknown[] {
  return [...post.mock.calls, ...patch.mock.calls]
    .map(([, body]) => (body as Record<string, unknown> | undefined)?.expires_at)
    .filter((v) => v !== undefined)
}

describe('ShareCreateDialog expiry', () => {
  let savedTZ: string | undefined
  beforeEach(() => {
    savedTZ = process.env.TZ
    process.env.TZ = 'America/New_York'
    expect(new Date(2026, 9, 20, 12).getTimezoneOffset()).toBe(240)
    post.mockReset().mockResolvedValue({ token: 'tok', title: 't' })
    patch.mockReset().mockResolvedValue({})
    get.mockReset().mockResolvedValue({})
  })
  afterEach(() => {
    if (savedTZ === undefined) delete process.env.TZ
    else process.env.TZ = savedTZ
  })

  it('a single-item link expires at the end of the picked day, local time', async () => {
    renderDialog([{ type: 'asset', id: 'a1', name: 'clip.mp4' }])
    pickExpiryAndCreate('2026-10-20')
    await waitFor(() => expect(sentExpiries()).toEqual([NY_END_OF_OCT_20]))
  })

  it('a multi-item link expires at the end of the picked day, local time', async () => {
    renderDialog([
      { type: 'asset', id: 'a1', name: 'clip.mp4' },
      { type: 'folder', id: 'f1', name: 'F' },
    ])
    pickExpiryAndCreate('2026-10-20')
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0][0]).toBe('/projects/p1/share/multi')
    expect(sentExpiries()).toEqual([NY_END_OF_OCT_20])
  })

  it('the created-link settings show the stored day and save a new one the same way', async () => {
    get.mockResolvedValue({
      permission: 'comment', allow_download: false, has_password: false,
      show_watermark: false, expires_at: NY_END_OF_OCT_20, appearance: {}, visibility: 'public',
    })
    render(
      <ShareCreateDialog
        open
        onOpenChange={() => {}}
        projectId="p1"
        currentFolderId={null}
        assets={[]}
        folders={[]}
        initialResult={{ token: 'tok', title: 'Link', itemType: 'asset', thumbnailUrl: null }}
        onShareCreated={() => {}}
      />,
    )
    fireEvent.click(await screen.findByText('Settings'))
    const input = document.querySelector('input[type="date"]') as HTMLInputElement
    // The stored instant is 03:59 UTC on the 21st; the day the user picked is the 20th.
    await waitFor(() => expect(input.value).toBe('2026-10-20'))

    fireEvent.change(input, { target: { value: '2026-10-21' } })
    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect(patch.mock.calls[0]).toEqual(['/share/tok', { expires_at: '2026-10-22T03:59:59.999Z' }])
  })
})
