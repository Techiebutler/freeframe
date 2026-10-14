import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { KeyboardShortcuts } from '../layout/keyboard-shortcuts'

describe('KeyboardShortcuts panel', () => {
  it('opens on ? and closes on ? again', () => {
    render(<KeyboardShortcuts standalone />)
    expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument()

    fireEvent.keyDown(document.body, { key: '?' })
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument()
    expect(screen.getByText('Select a range of assets')).toBeInTheDocument()

    fireEvent.keyDown(document.body, { key: '?' })
    expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument()
  })

  it('leaves ? alone while typing', () => {
    render(
      <>
        <textarea aria-label="comment" />
        <KeyboardShortcuts standalone />
      </>,
    )

    fireEvent.keyDown(screen.getByLabelText('comment'), { key: '?' })

    expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument()
  })

  it('lists no shortcut that nothing handles', () => {
    render(<KeyboardShortcuts standalone />)
    fireEvent.keyDown(document.body, { key: '?' })

    // These were listed for a long time with no handler behind them.
    for (const label of ['Toggle sidebar', 'Mute / unmute', 'Toggle fullscreen', 'New project', 'Go to home', 'Focus comment input']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
  })
})
