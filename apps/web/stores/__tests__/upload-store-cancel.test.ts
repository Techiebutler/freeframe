import { beforeEach, expect, it, vi } from 'vitest'

let releaseComplete: () => void = () => {}
const post = vi.fn(async (path: string) => {
  if (path === '/upload/initiate') return { upload_id: 'u', s3_key: 'k', asset_id: 'a', version_id: 'v' }
  if (path === '/upload/complete') return new Promise<void>((r) => { releaseComplete = r })
  return {}
})
vi.mock('@/lib/api', () => ({ api: { post: (...a: [string]) => post(...a), get: vi.fn() } }))
vi.mock('@/lib/upload-parts', async (orig) => ({ ...(await orig<object>()), uploadParts: vi.fn(async () => [{ part_number: 1, etag: 'e' }]) }))

import { useUploadStore } from '../upload-store'

beforeEach(() => { post.mockClear(); useUploadStore.setState({ files: [] }) })

it('keeps a cancelled upload cancelled even if /upload/complete was already in flight', async () => {
  const file = new File(['x'], 'Hook1.mp4', { type: 'video/mp4' })
  const id = useUploadStore.getState().startUpload(file, 'p', 'Hook1.mp4', 'P', 'f')
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith('/upload/complete', expect.anything()))
  useUploadStore.getState().cancelUpload(id)
  releaseComplete()
  await new Promise((r) => setTimeout(r, 0))
  expect(useUploadStore.getState().files.find((f) => f.id === id)?.status).toBe('cancelled')
})
