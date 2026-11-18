/**
 * An uploading row shows its speed and time left, right-aligned on the line
 * with its percentage, while bytes are moving -- and nowhere else.
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
import { useUploadSpeedStore } from '@/stores/upload-speed-store'
import { signInAs } from '@/test/upload-session'

// Rows belong to the account that added them, and the panel shows only the signed-in account's.
beforeEach(() => signInAs('u1'))

const MB = 1024 * 1024

function row(patch: Partial<UploadFile> = {}): UploadFile {
  return {
    id: 'row-1', fileName: 'A047C012.mov', fileSize: 1024, fileType: 'video/quicktime',
    projectId: 'p1', projectName: 'Season 2', assetName: 'A047C012',
    progress: 42, processingProgress: 0, status: 'uploading',
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

const speed = () => screen.queryByText(/MB\/s/)

describe('upload speed in the panel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUploadSpeedStore.setState({
      rates: { 'row-1': { bytesPerSecond: 12.4 * MB, secondsLeft: 170 } },
    })
  })

  it('shows speed and time left beside the percentage, pushed to the right', () => {
    open(row())

    expect(screen.getByText('Uploading 42%')).toBeInTheDocument()
    expect(speed()).toHaveTextContent('12.4 MB/s · 3 min left')
    expect(speed()).toHaveClass('ml-auto')
  })

  it('shows speed alone while there is no estimate', () => {
    useUploadSpeedStore.setState({ rates: { 'row-1': { bytesPerSecond: 0, secondsLeft: null } } })
    open(row())

    expect(screen.getByText('0 B/s')).toBeInTheDocument()
    expect(screen.queryByText(/left/)).not.toBeInTheDocument()
  })

  it.each([
    ['finalizing', { finalizing: true }],
    ['processing', { status: 'processing' as const, processingProgress: 12 }],
    ['another tab', { status: 'elsewhere' as const }],
  ])('shows none while %s', (_label, patch) => {
    open(row(patch))
    expect(speed()).not.toBeInTheDocument()
  })

  it('shows none for a row this tab is not measuring', () => {
    useUploadSpeedStore.setState({ rates: {} })
    open(row())
    expect(speed()).not.toBeInTheDocument()
  })
})
