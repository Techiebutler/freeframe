/**
 * Discard in the uploads panel: asked before it is done, and not offered at all
 * on an upload that is still running somewhere else.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The Failed tab switches on the panel's infinite scroll, which jsdom has no
// implementation for.
vi.stubGlobal(
  'IntersectionObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/lib/api', () => ({
  api: { post: vi.fn(), get: vi.fn().mockResolvedValue([]) },
}))

import { UploadsPanel } from '../uploads-panel'
import { useUploadStore, type UploadFile } from '@/stores/upload-store'

function row(patch: Partial<UploadFile> = {}): UploadFile {
  return {
    id: 'row-1', fileName: 'A047C012.mov', fileSize: 1024, fileType: 'video/quicktime',
    projectId: 'p1', projectName: 'Season 2', assetName: 'A047C012',
    progress: 40, processingProgress: 0, status: 'interrupted',
    assetId: 'a1', versionId: 'v1', uploadId: 'u1', createdAt: Date.now(),
    ...patch,
  }
}

function open(file: UploadFile, tab: 'Active' | 'Failed') {
  const discardUpload = vi.fn().mockResolvedValue(null)
  useUploadStore.setState({
    files: [file], panelOpen: true, historyLoaded: true, historyHasMore: false, discardUpload,
  })
  render(<UploadsPanel />)
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${tab}`) }))
  return discardUpload
}

const discardButton = () => screen.queryByTitle('Discard this upload and free the space it is holding')

describe('discarding from the uploads panel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('asks first, because the parts are gone the moment it returns', () => {
    const discardUpload = open(row(), 'Failed')

    fireEvent.click(discardButton()!)

    expect(screen.getByText('Discard A047C012.mov?')).toBeInTheDocument()
    expect(discardUpload).not.toHaveBeenCalled()
  })

  it('discards once confirmed', async () => {
    const discardUpload = open(row(), 'Failed')

    fireEvent.click(discardButton()!)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    await waitFor(() => expect(discardUpload).toHaveBeenCalledWith('row-1'))
  })

  it('keeps the question open and says why when nothing was discarded', async () => {
    const discardUpload = open(row(), 'Failed')
    discardUpload.mockResolvedValue('Could not reach storage.')

    fireEvent.click(discardButton()!)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    expect(await screen.findByText('Could not reach storage.')).toBeInTheDocument()
    expect(screen.getByText('Discard A047C012.mov?')).toBeInTheDocument()
  })

  it('offers neither Discard nor Resume on an upload another tab is sending', () => {
    open(row({ status: 'elsewhere' }), 'Active')

    expect(screen.getByText('Still uploading in another tab or on another device')).toBeInTheDocument()
    expect(discardButton()).toBeNull()
    expect(screen.queryByTitle(/^Resume/)).toBeNull()
  })
})
