/**
 * Transcode events are applied to the row of the version they name (#273).
 *
 * One asset can have two rows in Processing at once: v1 still transcoding and
 * v2 uploaded on top of it. Matched by asset alone, v1's `transcode_complete`
 * flipped both rows to Ready, and v2, no longer polled, stayed Ready while it
 * was still being transcoded. Its progress and failure did the same.
 *
 * An event with no version id is from a worker that predates it, and a row with
 * no version id has nothing to compare: both still match by asset.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { UseSSEOptions } from '@/hooks/use-sse'

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))

let handlers: UseSSEOptions = {}
vi.mock('@/hooks/use-sse', () => ({
  useSSE: (_projectId: string, h: UseSSEOptions) => {
    handlers = h
    return { connected: true }
  },
}))

import { api } from '@/lib/api'
import { UploadSSEBridge } from '../upload-sse-bridge'
import { useUploadStore, __uploadQueueTesting as testing } from '@/stores/upload-store'
import { signInAs, row } from '@/test/upload-session'

const rowOf = (id: string) => useUploadStore.getState().files.find((f) => f.id === id)!

function twoVersionsProcessing() {
  useUploadStore.setState({
    files: [
      row({ id: 'r1', status: 'processing', assetId: 'a', versionId: 'v1', processingProgress: 0 }),
      row({ id: 'r2', status: 'processing', assetId: 'a', versionId: 'v2', processingProgress: 0 }),
    ],
  })
  render(<UploadSSEBridge />)
}

beforeEach(() => {
  vi.clearAllMocks()
  testing.reset()
  handlers = {}
  vi.mocked(api.get).mockResolvedValue([] as never)
  signInAs('user-1')
})

afterEach(() => {
  cleanup()
  useUploadStore.setState({ files: [] })
  testing.reset()
})

describe('transcode events with two versions of one asset processing', () => {
  it('a finished transcode completes only its own version', () => {
    twoVersionsProcessing()

    handlers.onTranscodeComplete!({ asset_id: 'a', version_id: 'v1' })

    expect(rowOf('r1').status).toBe('complete')
    expect(rowOf('r2').status).toBe('processing')
  })

  it('a failed transcode fails only its own version', () => {
    twoVersionsProcessing()

    handlers.onTranscodeFailed!({ asset_id: 'a', version_id: 'v1', error: 'boom' })

    expect(rowOf('r1').status).toBe('failed')
    expect(rowOf('r2').status).toBe('processing')
    expect(rowOf('r2').error).toBeUndefined()
  })

  it('progress moves only its own version', () => {
    twoVersionsProcessing()

    handlers.onTranscodeProgress!({ asset_id: 'a', version_id: 'v2', percent: 40 })

    expect(rowOf('r1').processingProgress).toBe(0)
    expect(rowOf('r2').processingProgress).toBe(40)
  })

  it('an event with no version id still matches by asset', () => {
    twoVersionsProcessing()

    handlers.onTranscodeComplete!({ asset_id: 'a' } as never)

    expect(rowOf('r1').status).toBe('complete')
    expect(rowOf('r2').status).toBe('complete')
  })

  it('a row with no version id still matches by asset', () => {
    useUploadStore.setState({
      files: [row({ id: 'r', status: 'processing', assetId: 'a', versionId: undefined })],
    })

    useUploadStore.getState().markProcessingFailed('a', 'boom', 'v9')

    expect(rowOf('r').status).toBe('failed')
  })
})
