import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'

// The link's `permission` is one value, view, comment or approve, shown as two
// switches. The Comments switch used to write `comment` or `view` and read
// `approve` as comment, so on an approve link it showed on and turning it off
// and on again quietly turned approvals off. The switches now read the stored
// permission, and each write is one value that both agree on.

// The API, as far as these tests need it: a patch changes the stored link, and
// the next read of the link shows the change. A fake that always answers with
// the first link would keep the switches on whatever the code does.
let stored: Record<string, unknown>
const get = vi.fn()
const patch = vi.fn()
const post = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: (...a: unknown[]) => post(...a),
  },
}))

import { ShareLinkSettingsPanel } from '../share-link-detail'

const LINK = {
  id: 'l1', token: 'tok', title: 'Link', asset_id: 'a1', folder_id: null, project_id: null,
  permission: 'comment', visibility: 'public',
  allow_download: false, show_versions: true, show_watermark: false, is_enabled: true,
  has_password: false, password_value: null,
  appearance: {}, created_at: '2026-10-01T00:00:00Z', expires_at: null,
}

function renderPanel(permission: string) {
  stored = { ...LINK, permission }
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ShareLinkSettingsPanel token="tok" />
    </SWRConfig>,
  )
}

const comments = () => screen.getByRole('switch', { name: 'Comments' })
const approvals = () => screen.getByRole('switch', { name: 'Allow approvals' })
const on = (el: HTMLElement) => el.getAttribute('aria-checked') === 'true'

/** The permission values the panel has written to the link, in order. */
function written() {
  return patch.mock.calls
    .filter(([, body]) => body && 'permission' in (body as object))
    .map(([url, body]) => [url, (body as { permission: string }).permission])
}

describe('ShareLinkSettingsPanel permissions', () => {
  beforeEach(() => {
    get.mockReset().mockImplementation(async (url: string) => {
      if (url === '/share/tok/details') return { ...stored }
      if (url.startsWith('/users/search')) return [{ id: 'u2', name: 'Dana', email: 'dana@x.test' }]
      return []
    })
    patch.mockReset().mockImplementation(async (_url: string, body: Record<string, unknown>) => {
      stored = { ...stored, ...body }
      return { ...stored }
    })
    post.mockReset().mockResolvedValue({})
  })

  it('has an Allow approvals switch with its description', async () => {
    renderPanel('comment')
    await waitFor(() => expect(comments()).toBeTruthy())
    expect(approvals()).toBeTruthy()
    expect(screen.getByText('Let viewers approve, ask for changes or reject')).toBeTruthy()
    expect(approvals().getAttribute('aria-describedby')).toBeTruthy()
  })

  it('shows each permission as its two switches', async () => {
    const { unmount } = renderPanel('view')
    await waitFor(() => expect(comments()).toBeTruthy())
    expect([on(comments()), on(approvals())]).toEqual([false, false])
    unmount()

    const second = renderPanel('comment')
    await waitFor(() => expect(on(comments())).toBe(true))
    expect(on(approvals())).toBe(false)
    second.unmount()

    renderPanel('approve')
    await waitFor(() => expect(on(comments())).toBe(true))
    expect(on(approvals())).toBe(true)
  })

  it('approvals on writes approve, and comments reads on', async () => {
    renderPanel('view')
    await waitFor(() => expect(comments()).toBeTruthy())

    fireEvent.click(approvals())

    await waitFor(() => expect(on(approvals())).toBe(true))
    expect(written()).toEqual([['/share/tok', 'approve']])
    expect(on(comments())).toBe(true)
  })

  it('approvals off writes comment, and comments stays on', async () => {
    renderPanel('approve')
    await waitFor(() => expect(on(approvals())).toBe(true))

    fireEvent.click(approvals())

    await waitFor(() => expect(on(approvals())).toBe(false))
    expect(written()).toEqual([['/share/tok', 'comment']])
    expect(on(comments())).toBe(true)
  })

  it('comments off on an approve link writes view, and approvals reads off', async () => {
    renderPanel('approve')
    await waitFor(() => expect(on(approvals())).toBe(true))

    fireEvent.click(comments())

    await waitFor(() => expect(on(comments())).toBe(false))
    expect(written()).toEqual([['/share/tok', 'view']])
    expect(on(approvals())).toBe(false)
  })

  it('comments off then on after that leaves comment, with approvals off and said so', async () => {
    renderPanel('approve')
    await waitFor(() => expect(on(approvals())).toBe(true))

    fireEvent.click(comments())
    await waitFor(() => expect(on(comments())).toBe(false))
    fireEvent.click(comments())
    await waitFor(() => expect(on(comments())).toBe(true))

    expect(written()).toEqual([['/share/tok', 'view'], ['/share/tok', 'comment']])
    expect(on(approvals())).toBe(false)
  })

  it('an invite from an approve link carries approve, which the direct-share routes accept', async () => {
    // /{assets|folders|projects}/{id}/share/user take SharePermission, and the
    // sharepermission enum in the database holds approve. Measured against the
    // three routes: each answers 201 and returns approve.
    renderPanel('approve')
    await waitFor(() => expect(on(comments())).toBe(true))

    fireEvent.change(screen.getByPlaceholderText('Send to name or email'), { target: { value: 'dan' } })
    fireEvent.click(await screen.findByText('Dana'))

    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post).toHaveBeenCalledWith('/assets/a1/share/user', {
      permission: 'approve',
      user_id: 'u2',
      share_token: 'tok',
    })
  })
})
