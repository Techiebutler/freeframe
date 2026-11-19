import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

// The dialog shows a link's permission, view, comment or approve, as two
// switches, and writes it as one value. Approving is a kind of commenting, so
// approvals on shows comments on, and comments off shows approvals off. The
// Comments switch used to write `comment` over `approve` and read `approve` as
// plain comment, so a link's approvals went away without the dialog saying so.

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

type Item = { type: 'asset' | 'folder'; id: string; name: string }

function renderConfigure(items: Item[] = [{ type: 'folder', id: 'f1', name: 'F' }]) {
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

async function renderCreated(permission: string) {
  get.mockResolvedValue({
    permission, allow_download: false, has_password: false,
    show_watermark: false, expires_at: null, appearance: {}, visibility: 'public',
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
  // The settings are read from the link, so wait for them to land.
  await waitFor(() => expect(get).toHaveBeenCalledWith('/share/tok/details'))
  await screen.findByRole('switch', { name: 'Allow approvals' })
}

const comments = () => screen.getByRole('switch', { name: 'Allow comments' })
const approvals = () => screen.getByRole('switch', { name: 'Allow approvals' })
const on = (el: HTMLElement) => el.getAttribute('aria-checked') === 'true'
const state = () => [on(comments()), on(approvals())]

/** The permission values written to the existing link, in order. */
function written() {
  return patch.mock.calls
    .filter(([, body]) => body && 'permission' in (body as object))
    .map(([url, body]) => [url, (body as { permission: string }).permission])
}

describe('ShareCreateDialog configuring a link', () => {
  beforeEach(() => {
    post.mockReset().mockResolvedValue({ token: 'tok', title: 't' })
    patch.mockReset().mockResolvedValue({})
    get.mockReset().mockResolvedValue({})
  })

  it('starts on comments, without approvals, and says what approvals do', () => {
    renderConfigure()
    expect(state()).toEqual([true, false])
    expect(screen.getByText('Let viewers approve, ask for changes or reject')).toBeTruthy()
    expect(approvals().getAttribute('aria-describedby')).toBeTruthy()
  })

  it('approvals on shows comments on, and the link is created with approve', async () => {
    renderConfigure()
    fireEvent.click(approvals())
    expect(state()).toEqual([true, true])

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0][0]).toBe('/folders/f1/share')
    expect(post.mock.calls[0][1]).toMatchObject({ permission: 'approve' })
  })

  it('approvals on with comments off first shows comments on', async () => {
    renderConfigure()
    fireEvent.click(comments())
    expect(state()).toEqual([false, false])

    fireEvent.click(approvals())
    expect(state()).toEqual([true, true])

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0][1]).toMatchObject({ permission: 'approve' })
  })

  it('comments off turns approvals off, and the link is created with view', async () => {
    renderConfigure()
    fireEvent.click(approvals())
    fireEvent.click(comments())
    expect(state()).toEqual([false, false])

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0][1]).toMatchObject({ permission: 'view' })
  })

  it('comments back on after that is comment only, not approve', async () => {
    renderConfigure()
    fireEvent.click(approvals())
    fireEvent.click(comments())
    fireEvent.click(comments())
    expect(state()).toEqual([true, false])

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0][1]).toMatchObject({ permission: 'comment' })
  })

  it('a link over several items takes approve in the same request', async () => {
    renderConfigure([
      { type: 'asset', id: 'a1', name: 'clip.mp4' },
      { type: 'folder', id: 'f1', name: 'F' },
    ])
    fireEvent.click(approvals())
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0][0]).toBe('/projects/p1/share/multi')
    expect(post.mock.calls[0][1]).toMatchObject({ permission: 'approve' })
  })

  it('locks the approvals switch once the link exists, like the others', async () => {
    renderConfigure()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await screen.findByText(/\/share\/tok$/)
    // The settings sit in a disabled fieldset, which disables the switches
    // inside it without putting `disabled` on each one.
    expect(approvals().matches(':disabled')).toBe(true)
    expect(comments().matches(':disabled')).toBe(true)
  })
})

describe('ShareCreateDialog settings of a link that exists', () => {
  beforeEach(() => {
    post.mockReset()
    patch.mockReset().mockResolvedValue({})
    get.mockReset()
  })

  it('the summary line names approving only when the link allows it', async () => {
    get.mockResolvedValue({
      permission: 'approve', allow_download: false, has_password: false,
      show_watermark: false, expires_at: null, appearance: {}, visibility: 'public',
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
    expect(await screen.findByText('Anyone with the link can view, comment, approve.')).toBeTruthy()
  })

  it('shows each permission as its two switches', async () => {
    await renderCreated('view')
    await waitFor(() => expect(state()).toEqual([false, false]))
  })

  it('shows a comment link as comments on and approvals off', async () => {
    await renderCreated('comment')
    await waitFor(() => expect(state()).toEqual([true, false]))
  })

  it('shows an approve link as comments on and approvals on', async () => {
    await renderCreated('approve')
    await waitFor(() => expect(state()).toEqual([true, true]))
  })

  it('approvals on writes approve, and comments reads on', async () => {
    await renderCreated('view')
    await waitFor(() => expect(state()).toEqual([false, false]))

    fireEvent.click(approvals())

    expect(state()).toEqual([true, true])
    expect(written()).toEqual([['/share/tok', 'approve']])
  })

  it('approvals off writes comment, and comments stays on', async () => {
    await renderCreated('approve')
    await waitFor(() => expect(state()).toEqual([true, true]))

    fireEvent.click(approvals())

    expect(state()).toEqual([true, false])
    expect(written()).toEqual([['/share/tok', 'comment']])
  })

  it('comments off on an approve link writes view, and approvals reads off', async () => {
    await renderCreated('approve')
    await waitFor(() => expect(state()).toEqual([true, true]))

    fireEvent.click(comments())

    expect(state()).toEqual([false, false])
    expect(written()).toEqual([['/share/tok', 'view']])
  })

  it('comments off and on again leaves comment, with approvals off and shown off', async () => {
    await renderCreated('approve')
    await waitFor(() => expect(state()).toEqual([true, true]))

    fireEvent.click(comments())
    fireEvent.click(comments())

    expect(state()).toEqual([true, false])
    expect(written()).toEqual([['/share/tok', 'view'], ['/share/tok', 'comment']])
  })
})
