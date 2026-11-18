import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { ShareCreateDialog } from '../share-create-dialog'

// The API shows a link's password only to the people who manage it, and can
// fail to show it to them too (the key it was stored under changed). Either
// way the panel gets has_password: true with password_value: null, and must
// say a password is set rather than show an empty box. Removing the password
// is the toggle's job: emptying the box never saves "no password".

const LINK = {
  id: 'l1', token: 'tok', title: 'Link', permission: 'comment', visibility: 'public',
  allow_download: false, show_versions: true, show_watermark: false, is_enabled: true,
  appearance: {}, created_at: '2026-10-01T00:00:00Z', expires_at: null,
}

const settle = () => new Promise((r) => setTimeout(r, 450))

// The API limits a link password to 128 UTF-8 bytes. '€' is 3 bytes and one
// UTF-16 unit, so 43 of them is 129 bytes in a 43-character string: a check on
// .length (or maxLength) passes it, a byte check does not.
const OVER_LIMIT = '€'.repeat(43)
const AT_LIMIT = '€'.repeat(42) + 'ab'

function passwordPatches() {
  return patch.mock.calls.filter(([, body]) => body && 'password' in (body as object))
}

function renderPanel() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ShareLinkSettingsPanel token="tok" />
    </SWRConfig>,
  )
}

async function passwordInput() {
  return waitFor(() => {
    const el = document.querySelector('input[autocomplete="new-password"]') as HTMLInputElement | null
    expect(el).not.toBeNull()
    return el!
  })
}

describe('ShareLinkSettingsPanel password', () => {
  beforeEach(() => {
    get.mockReset()
    patch.mockReset().mockResolvedValue({})
  })

  it('shows "Password set" when the link has a password it is not shown', async () => {
    get.mockResolvedValue({ ...LINK, has_password: true, password_value: null })
    renderPanel()
    const input = await passwordInput()
    expect(input.value).toBe('')
    expect(screen.getByText('Password set')).toBeTruthy()
    expect(input.placeholder).toMatch(/replace/i)
    await settle()
    expect(patch).not.toHaveBeenCalled()
  })

  it('shows the password itself to someone who is given it', async () => {
    get.mockResolvedValue({ ...LINK, has_password: true, password_value: 'hunter22' })
    renderPanel()
    const input = await passwordInput()
    await waitFor(() => expect(input.value).toBe('hunter22'))
    expect(screen.queryByText('Password set')).toBeNull()
    await settle()
    expect(patch).not.toHaveBeenCalled()
  })

  it('typing a new password replaces it', async () => {
    get.mockResolvedValue({ ...LINK, has_password: true, password_value: null })
    renderPanel()
    const input = await passwordInput()
    fireEvent.change(input, { target: { value: 'newpass' } })
    await waitFor(() => expect(passwordPatches()).toEqual([['/share/tok', { password: 'newpass' }]]))
  })

  it('emptying the box does not remove the password', async () => {
    get.mockResolvedValue({ ...LINK, has_password: true, password_value: 'hunter22' })
    renderPanel()
    const input = await passwordInput()
    await waitFor(() => expect(input.value).toBe('hunter22'))
    fireEvent.change(input, { target: { value: '' } })
    await settle()
    expect(passwordPatches()).toEqual([])
  })

  it('emptying the box drops a change still waiting to be saved', async () => {
    get.mockResolvedValue({ ...LINK, has_password: true, password_value: null })
    renderPanel()
    const input = await passwordInput()
    fireEvent.change(input, { target: { value: 'ab' } })
    fireEvent.change(input, { target: { value: '' } })
    await settle()
    expect(passwordPatches()).toEqual([])
  })

  it('the toggle is what removes the password', async () => {
    get.mockResolvedValue({ ...LINK, has_password: true, password_value: null })
    renderPanel()
    await passwordInput()
    fireEvent.click(screen.getByRole('switch', { name: /passphrase/i }))
    await waitFor(() => expect(passwordPatches()).toEqual([['/share/tok', { password: null }]]))
  })

  it('turning the toggle off drops a typed password still waiting to be saved', async () => {
    get.mockResolvedValue({ ...LINK, has_password: true, password_value: null })
    renderPanel()
    const input = await passwordInput()
    fireEvent.change(input, { target: { value: 'newpass' } })
    fireEvent.click(screen.getByRole('switch', { name: /passphrase/i }))
    await settle()
    expect(passwordPatches()).toEqual([['/share/tok', { password: null }]])
  })

  it('does not save a password over 128 bytes and says why', async () => {
    get.mockResolvedValue({ ...LINK, has_password: true, password_value: null })
    renderPanel()
    const input = await passwordInput()
    // A valid prefix still waiting to be saved is dropped too, so the link is
    // never left with a password the person did not finish typing.
    fireEvent.change(input, { target: { value: 'newpass' } })
    fireEvent.change(input, { target: { value: OVER_LIMIT } })
    expect(screen.getByRole('alert').textContent).toMatch(/128 bytes/)
    await settle()
    expect(passwordPatches()).toEqual([])
  })

  it('saves a password of exactly 128 bytes, and shortening clears the message', async () => {
    get.mockResolvedValue({ ...LINK, has_password: true, password_value: null })
    renderPanel()
    const input = await passwordInput()
    fireEvent.change(input, { target: { value: OVER_LIMIT } })
    expect(screen.queryByRole('alert')).not.toBeNull()
    fireEvent.change(input, { target: { value: AT_LIMIT } })
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() => expect(passwordPatches()).toEqual([['/share/tok', { password: AT_LIMIT }]]))
  })
})

describe('ShareCreateDialog created-link password', () => {
  beforeEach(() => {
    get.mockReset()
    patch.mockReset().mockResolvedValue({})
  })

  async function openSettings(details: Record<string, unknown>) {
    get.mockResolvedValue({ ...LINK, ...details })
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
    return passwordInput()
  }

  it('says a password is set and does not save on load', async () => {
    const input = await openSettings({ has_password: true, password_value: null })
    expect(input.value).toBe('')
    expect(input.placeholder).toMatch(/password set/i)
    await settle()
    expect(patch).not.toHaveBeenCalled()
  })

  it('emptying the box does not remove the password', async () => {
    const input = await openSettings({ has_password: true, password_value: null })
    fireEvent.change(input, { target: { value: 'ab' } })
    fireEvent.change(input, { target: { value: '' } })
    await settle()
    expect(passwordPatches()).toEqual([])
  })

  it('typing a new password saves it', async () => {
    const input = await openSettings({ has_password: true, password_value: null })
    fireEvent.change(input, { target: { value: 'newpass' } })
    await waitFor(() => expect(passwordPatches()).toEqual([['/share/tok', { password: 'newpass' }]]))
  })

  it('turning the switch off drops a typed password still waiting to be saved', async () => {
    const input = await openSettings({ has_password: true, password_value: null })
    fireEvent.change(input, { target: { value: 'newpass' } })
    // The dialog's switches have no names; this one sits beside "Passphrase".
    const row = screen.getByText('Passphrase').parentElement!.parentElement!
    fireEvent.click(row.querySelector('[role="switch"]')!)
    await settle()
    expect(passwordPatches()).toEqual([['/share/tok', { password: null }]])
  })

  it('does not save a password over 128 bytes and says why', async () => {
    const input = await openSettings({ has_password: true, password_value: null })
    fireEvent.change(input, { target: { value: 'newpass' } })
    fireEvent.change(input, { target: { value: OVER_LIMIT } })
    expect(screen.getByRole('alert').textContent).toMatch(/128 bytes/)
    await settle()
    expect(passwordPatches()).toEqual([])
  })

  it('saves a password of exactly 128 bytes, and shortening clears the message', async () => {
    const input = await openSettings({ has_password: true, password_value: null })
    fireEvent.change(input, { target: { value: OVER_LIMIT } })
    expect(screen.queryByRole('alert')).not.toBeNull()
    fireEvent.change(input, { target: { value: AT_LIMIT } })
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() => expect(passwordPatches()).toEqual([['/share/tok', { password: AT_LIMIT }]]))
  })
})
