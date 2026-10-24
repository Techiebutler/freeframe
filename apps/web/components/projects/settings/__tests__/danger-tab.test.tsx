import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'

const { api, push } = vi.hoisted(() => ({
  api: { delete: vi.fn() },
  push: vi.fn(),
}))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }))

import { ProjectDangerTab } from '../danger-tab'

// Deleting a project used to be a native confirm() in the card menu that
// swallowed any failure. It is now one place, behind typing the name, with
// copy that says what happens: gone at once, purged later, no restore.

function openDialog() {
  render(<ProjectDangerTab projectId="p1" projectName="Launch film" />)
  fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
  return screen.getByRole('dialog')
}

beforeEach(() => {
  api.delete.mockReset().mockResolvedValue(undefined)
  push.mockReset()
})

describe('deleting a project', () => {
  it('says the project goes now, is purged after the retention period, and cannot be restored', () => {
    render(<ProjectDangerTab projectId="p1" projectName="Launch film" />)
    expect(screen.getByText(/permanently deleted after the retention period/)).toBeInTheDocument()
    expect(screen.getByText(/cannot be restored from the app/)).toBeInTheDocument()
  })

  it('only allows the delete once the name is typed exactly', () => {
    const dialog = openDialog()
    const confirm = within(dialog).getByRole('button', { name: 'Delete project' })
    const input = within(dialog).getByLabelText(/Type Launch film to confirm/)
    expect(confirm).toBeDisabled()

    fireEvent.change(input, { target: { value: 'launch film' } })
    expect(confirm).toBeDisabled()
    fireEvent.change(input, { target: { value: 'Launch film' } })
    expect(confirm).toBeEnabled()
  })

  it('deletes and goes to the project list', async () => {
    const dialog = openDialog()
    fireEvent.change(within(dialog).getByLabelText(/Type Launch film to confirm/), {
      target: { value: 'Launch film' },
    })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }))
    })
    expect(api.delete).toHaveBeenCalledWith('/projects/p1')
    expect(push).toHaveBeenCalledWith('/projects')
  })

  it('shows the API error in the dialog and stays put', async () => {
    api.delete.mockRejectedValueOnce(new Error('Only the project owner can do this'))
    const dialog = openDialog()
    fireEvent.change(within(dialog).getByLabelText(/Type Launch film to confirm/), {
      target: { value: 'Launch film' },
    })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }))
    })
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent(
      'Only the project owner can do this',
    )
    expect(push).not.toHaveBeenCalled()
  })
})
