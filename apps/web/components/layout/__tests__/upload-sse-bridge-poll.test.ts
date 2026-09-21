/**
 * How often the uploads panel falls back to polling.
 */
import { describe, it, expect } from 'vitest'
import { pollIntervalFor } from '../upload-sse-bridge'
import type { UploadFile, UploadStatus } from '@/stores/upload-store'

function rowAt(status: UploadStatus, assetId: string | null = 'asset-1'): UploadFile {
  return {
    id: `${status}-${assetId}`, fileName: 'clip.mp4', fileSize: 1, fileType: 'video/mp4',
    projectId: 'p', assetName: 'clip', progress: 0, processingProgress: 0,
    status, assetId: assetId ?? undefined, createdAt: 0,
  }
}

describe('pollIntervalFor', () => {
  it('does not poll when nothing can change behind the panel', () => {
    expect(pollIntervalFor([])).toBe(0)
    expect(pollIntervalFor([rowAt('complete'), rowAt('failed'), rowAt('cancelled')])).toBe(0)
  })

  it('polls quickly while a transcode can finish between two SSE events', () => {
    expect(pollIntervalFor([rowAt('processing'), rowAt('interrupted')])).toBe(5000)
  })

  it('polls slowly for a stopped upload that may be resumed somewhere else', () => {
    expect(pollIntervalFor([rowAt('interrupted')])).toBe(30000)
  })

  it('polls slowly for an upload another tab is sending, to notice it stop', () => {
    expect(pollIntervalFor([rowAt('elsewhere', null)])).toBe(30000)
  })

  it('leaves out a row with no asset to ask about', () => {
    expect(pollIntervalFor([rowAt('interrupted', null)])).toBe(0)
  })
})
