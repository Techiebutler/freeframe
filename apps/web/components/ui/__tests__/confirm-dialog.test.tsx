import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from '../confirm-dialog'

describe('busy confirmation', () => {
  it('ignores Escape and outside clicks while a purge is pending, then exposes its refusal', async () => {
    const change = vi.fn()
    let reject!: (reason: Error) => void
    const confirm = vi.fn(() => new Promise<void>((_resolve, no) => { reject = no }))
    render(<ConfirmDialog open onOpenChange={change} title="Purge synthetic item" description="Synthetic data only" onConfirm={confirm} />)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireEvent.pointerDown(document.body, { button: 0, pointerType: 'mouse' })
    expect(change).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    reject(new Error('refused'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled())
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(change).toHaveBeenCalledWith(false)
  })
})
