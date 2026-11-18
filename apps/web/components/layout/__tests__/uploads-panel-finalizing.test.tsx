/**
 * A row whose bytes are all across says it is finalizing, and offers no Cancel:
 * the storage backend is assembling the parts and a cancel would race that.
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
import { render, screen } from '@testing-library/react'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn().mockResolvedValue([]) },
}))

import { UploadsPanel } from '../uploads-panel'
import { useUploadStore, type UploadFile } from '@/stores/upload-store'
import { signInAs } from '@/test/upload-session'

// Rows belong to the account that added them, and the panel shows only the signed-in account's.
beforeEach(() => signInAs('u1'))

function row(patch: Partial<UploadFile> = {}): UploadFile {
  return {
    id: 'row-1', fileName: 'A047C012.mov', fileSize: 1024, fileType: 'video/quicktime',
    projectId: 'p1', projectName: 'Season 2', assetName: 'A047C012',
    progress: 95, processingProgress: 0, status: 'uploading',
    assetId: 'a1', versionId: 'v1', uploadId: 'u1', createdAt: Date.now(), ownerId: 'u1',
    ...patch,
  }
}

function open(file: UploadFile) {
  useUploadStore.setState({
    files: [file], panelOpen: true, historyLoaded: true, historyHasMore: false,
  })
  render(<UploadsPanel />)
}

const cancelButton = () => screen.queryByTitle('Cancel upload')

describe('a finalizing upload in the panel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('says Finalizing instead of a stuck percentage, and offers no Cancel', () => {
    open(row({ finalizing: true }))

    expect(screen.getByText('Finalizing')).toBeInTheDocument()
    expect(screen.getByText('Finalizing…')).toBeInTheDocument()
    expect(screen.queryByText('Uploading 95%')).not.toBeInTheDocument()
    expect(cancelButton()).not.toBeInTheDocument()
  })

  it('reads as uploading, with Cancel, until then', () => {
    open(row())

    expect(screen.getByText('Uploading 95%')).toBeInTheDocument()
    expect(screen.queryByText('Finalizing…')).not.toBeInTheDocument()
    expect(cancelButton()).toBeInTheDocument()
  })

  it('ignores a stale flag on a row that is no longer uploading', () => {
    open(row({ finalizing: true, status: 'processing', processingProgress: 12 }))

    expect(screen.getByText('Processing 12%')).toBeInTheDocument()
    expect(screen.queryByText('Finalizing…')).not.toBeInTheDocument()
  })

  it('a processing row with no percentage yet uses the same ellipsis as the rest of the panel', () => {
    open(row({ status: 'processing', processingProgress: 0 }))

    expect(screen.getByText('Processing…')).toBeInTheDocument()
  })
})
