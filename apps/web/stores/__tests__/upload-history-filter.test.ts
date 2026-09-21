/**
 * The uploads panel has to ask for the user's own uploads, not for everything.
 *
 * `GET /me/assets` without a filter returns every asset in every project the
 * user is a member of, in any role, plus anything shared with or assigned to
 * them. So a reviewer who has never uploaded a file saw other people's cuts
 * listed under "Uploads".
 *
 * Both pages are pinned, not just the first. Filtering only `fetchHistory`
 * would be worse than filtering neither: the panel would look right until
 * someone scrolled, and then start filling with strangers' assets halfway down
 * a list nobody would think to distrust.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { post: vi.fn(), get: vi.fn() },
}))

import { api } from '@/lib/api'
import { useUploadStore } from '../upload-store'

/** Every `/me/assets` path the store requested, in order. */
function historyRequests(): string[] {
  return vi
    .mocked(api.get)
    .mock.calls.map((c) => String(c[0]))
    .filter((p) => p.startsWith('/me/assets'))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.get).mockResolvedValue([] as never)
  useUploadStore.setState({
    files: [],
    historyLoaded: false,
    historyLoading: false,
    historySkip: 0,
    historyHasMore: true,
  })
})

describe('the uploads panel asks only for the user’s own assets', () => {
  it('asks for filter=owned on the first page', async () => {
    await useUploadStore.getState().fetchHistory()

    expect(historyRequests()).toHaveLength(1)
    expect(historyRequests()[0]).toContain('filter=owned')
  })

  it('asks for filter=owned on every later page too', async () => {
    // The mutation this exists for: fixing `fetchHistory` and forgetting
    // `fetchMoreHistory`, which leaves the bug one scroll away.
    useUploadStore.setState({ historySkip: 20, historyHasMore: true })
    await useUploadStore.getState().fetchMoreHistory()

    expect(historyRequests()).toHaveLength(1)
    expect(historyRequests()[0]).toContain('filter=owned')
    expect(historyRequests()[0]).toContain('skip=20')
  })

  it('never asks without a filter', async () => {
    await useUploadStore.getState().fetchHistory()
    useUploadStore.setState({ historyLoading: false, historyHasMore: true })
    await useUploadStore.getState().fetchMoreHistory()

    expect(historyRequests()).toHaveLength(2)
    for (const path of historyRequests()) {
      expect(path).toMatch(/[?&]filter=owned(&|$)/)
    }
  })
})
