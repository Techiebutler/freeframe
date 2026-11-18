/**
 * What the Uploads panel says about a drop beyond its rows, and how it gets
 * out of the way of the next one.
 *
 * A drop that leaves files out (unsupported types, unreadable files, folders
 * that could not be made) says so in a dismissible line at the top of the
 * panel. And dragging files over the open panel closes it: the panel and its
 * backdrop cover the page, so leaving them up would make a second drop land on
 * them instead of on the asset area underneath.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.stubGlobal(
  'IntersectionObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn().mockResolvedValue([]) },
}))

import { UploadsPanel } from '../uploads-panel'
import { useUploadStore } from '@/stores/upload-store'
import { signInAs } from '@/test/upload-session'

beforeEach(() => {
  signInAs('u1')
  useUploadStore.setState({ files: [], dropNotes: [], panelOpen: true, historyLoaded: true, historyHasMore: false })
})

const panel = () => {
  const el = screen.getByRole('heading', { name: /Uploads/ }).closest('.z-50')
  if (!el) throw new Error('no panel')
  return el
}

describe('drop notes', () => {
  it('shows each note at the top of the panel until it is dismissed', () => {
    render(<UploadsPanel />)
    act(() => {
      useUploadStore.getState().addDropNote("Skipped 3 files that can't be uploaded (.txt, .zip)")
      useUploadStore.getState().addDropNote('2 files or folders could not be read')
    })

    expect(screen.getByText("Skipped 3 files that can't be uploaded (.txt, .zip)")).toBeInTheDocument()
    expect(screen.getByText('2 files or folders could not be read')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0])

    expect(screen.queryByText("Skipped 3 files that can't be uploaded (.txt, .zip)")).toBeNull()
    expect(screen.getByText('2 files or folders could not be read')).toBeInTheDocument()
  })

  it('shows them whichever tab is chosen', () => {
    render(<UploadsPanel />)
    act(() => useUploadStore.getState().addDropNote('There were no files to upload.'))

    fireEvent.click(screen.getByRole('button', { name: /^Failed/ }))

    expect(screen.getByText('There were no files to upload.')).toBeInTheDocument()
  })
})

describe('a file dragged over the open panel', () => {
  it('closes the panel', () => {
    render(<UploadsPanel />)

    fireEvent.dragEnter(panel(), { dataTransfer: { types: ['Files'] } })

    expect(useUploadStore.getState().panelOpen).toBe(false)
  })

  it('closes it from the backdrop too', () => {
    render(<UploadsPanel />)
    const backdrop = panel().previousElementSibling!

    fireEvent.dragEnter(backdrop, { dataTransfer: { types: ['Files'] } })

    expect(useUploadStore.getState().panelOpen).toBe(false)
  })

  it('leaves it open for a drag that carries no files', () => {
    render(<UploadsPanel />)

    fireEvent.dragEnter(panel(), { dataTransfer: { types: ['text/plain'] } })

    expect(useUploadStore.getState().panelOpen).toBe(true)
  })
})
