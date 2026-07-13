import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FpsPromptDialog } from '../fps-prompt-dialog'

describe('FpsPromptDialog (#84)', () => {
  it('does not render its content when closed', () => {
    render(
      <FpsPromptDialog open={false} onOpenChange={vi.fn()} onConfirm={vi.fn()} />,
    )

    expect(screen.queryByText('Frame rate needed')).not.toBeInTheDocument()
  })

  it('renders all 9 fps options when open', () => {
    render(
      <FpsPromptDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />,
    )

    expect(screen.getByText('Frame rate needed')).toBeInTheDocument()
    for (const option of [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60]) {
      expect(screen.getByText(String(option))).toBeInTheDocument()
    }
  })

  it('selecting a preset then confirming exports that fps and closes the dialog', () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <FpsPromptDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} />,
    )

    fireEvent.click(screen.getByText('29.97'))
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))

    expect(onConfirm).toHaveBeenCalledWith(29.97)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('cancel closes the dialog without confirming', () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <FpsPromptDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
