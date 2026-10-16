import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NameDialog } from '../name-dialog'

// Rename opens with the name focused and selected, so typing replaces it.

function Harness({ open, name }: { open: boolean; name: string }) {
  return (
    <NameDialog
      open={open}
      onOpenChange={() => {}}
      title="Rename Asset"
      defaultValue={name}
      submitLabel="Rename"
      onSubmit={vi.fn()}
    />
  )
}

describe('NameDialog', () => {
  it('opens with the whole name selected, even when the name arrives with the open', async () => {
    // The page's asset rename dialog is mounted once, empty, and gets the
    // asset's name only when it opens.
    const { rerender } = render(<Harness open={false} name="" />)
    rerender(<Harness open name="Clip 1" />)

    const input = (await screen.findByRole('textbox')) as HTMLInputElement
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(input.value).toBe('Clip 1')
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'Clip 1'.length])

    await userEvent.keyboard('Hero')
    expect(input.value).toBe('Hero')
  })

  it('starts from the current name each time it opens', async () => {
    const { rerender } = render(<Harness open name="Clip 1" />)
    await userEvent.type(await screen.findByRole('textbox'), ' edited')
    rerender(<Harness open={false} name="Clip 1" />)
    rerender(<Harness open name="Clip 2" />)
    expect(((await screen.findByRole('textbox')) as HTMLInputElement).value).toBe('Clip 2')
  })
})
