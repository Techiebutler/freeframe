import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ShareCreateDialog } from '../share-create-dialog'

// Creating a link used to close the dialog at once, so the person never saw the
// URL. It now stays open on the same screen: Create turns into Copy where it
// stands, and Close appears beneath it.

const mockApi = vi.hoisted(() => ({
  post: vi.fn(),
  patch: vi.fn(),
  get: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ api: mockApi }))

const mockCopy = vi.hoisted(() => vi.fn())
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  copyToClipboard: mockCopy,
}))

const preselectedItem = { type: 'folder' as const, id: 'f1', name: 'Dailies' }

function renderDialog() {
  const onOpenChange = vi.fn()
  const onShareCreated = vi.fn()
  render(
    <ShareCreateDialog
      open
      onOpenChange={onOpenChange}
      projectId="p1"
      currentFolderId={null}
      assets={[]}
      folders={[]}
      preselectedItem={preselectedItem}
      onShareCreated={onShareCreated}
    />,
  )
  return { onOpenChange, onShareCreated }
}

describe('ShareCreateDialog after Create', () => {
  beforeEach(() => {
    mockApi.post.mockReset().mockResolvedValue({ token: 'abc123' })
    mockApi.patch.mockReset().mockResolvedValue({})
    mockCopy.mockReset().mockResolvedValue(true)
  })

  it('stays open and shows the new link with Copy and Close', async () => {
    const { onOpenChange, onShareCreated } = renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    const url = await screen.findByText(/\/share\/abc123$/)
    expect(url).toBeTruthy()
    expect(onShareCreated).toHaveBeenCalledOnce()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })

  it('turns Create into Copy in place, so a second click copies', async () => {
    renderDialog()
    const create = screen.getByRole('button', { name: 'Create' })

    fireEvent.click(create)
    await screen.findByText(/\/share\/abc123$/)

    // Same element, not a new button somewhere else
    expect(screen.getByRole('button', { name: 'Copy' })).toBe(create)
    fireEvent.click(create)
    await waitFor(() => expect(mockCopy).toHaveBeenCalledOnce())
  })

  it('copies the link and says so', async () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await screen.findByText(/\/share\/abc123$/)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

    await waitFor(() => expect(screen.getByText('Copied!')).toBeTruthy())
    expect(mockCopy).toHaveBeenCalledWith(expect.stringMatching(/\/share\/abc123$/))
  })

  it('closes from the Close button', async () => {
    const { onOpenChange } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
