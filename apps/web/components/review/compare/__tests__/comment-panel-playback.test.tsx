import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'
import * as utils from '@/lib/utils'
import { api } from '@/lib/api'
import { useReviewStore } from '@/stores/review-store'
import { useAuthStore } from '@/stores/auth-store'
import type { CommentWithReplies } from '@/hooks/use-comments'
import type { AssetResponse, AssetVersion } from '@/types'

let search = 'compare=v-1'
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/projects/p1/assets/a1',
  useSearchParams: () => new URLSearchParams(search),
}))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }))
vi.mock('@/hooks/use-stream-url', () => ({ useStreamUrl: () => ({ url: null, error: false }) }))
vi.mock('@/components/review/review-provider', () => ({
  useReview: () => ({ pauseVideo: vi.fn() }),
}))
// Keep the real transport clock and both real comment panels. Replace the video
// loader because jsdom cannot decode video; stable refs let the real
// transport attach to the two <video>s rendered by CompareOverlay.
vi.mock('@/hooks/use-video-player', async () => {
  const React = await import('react')
  return {
    useVideoPlayer: () => ({ videoRef: React.useRef(null), state: { duration: 60 } }),
  }
})
vi.mock('fabric', () => ({
  Canvas: class {
    setDimensions() {}
    async loadFromJSON() { return this }
    getObjects() { return [] }
    renderAll() {}
    dispose() {}
  },
}))

import { CompareOverlay } from '../compare-overlay'

const asset = { id: 'a1', project_id: 'p1', name: 'Synthetic review', asset_type: 'video' } as AssetResponse
const versions = [1, 2, 3].map((n) => ({
  id: `v-${n}`, asset_id: 'a1', version_number: n, processing_status: 'ready',
  files: [{ fps: n === 1 ? 24 : 60, duration_seconds: 60 }],
})) as AssetVersion[]
const onClose = vi.fn()
let server: Record<string, CommentWithReplies[]>
let rafs: Map<number, FrameRequestCallback>
let rafId: number
let now: number

function comment(id: string, versionId: string, overrides = {}): CommentWithReplies {
  return {
    id, asset_id: 'a1', version_id: versionId, parent_id: null,
    author_id: 'u1', guest_author_id: null, body: id, timecode_start: 5,
    timecode_end: null, resolved: false, visibility: 'all', deleted_at: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    author: { id: 'u1', name: 'Synthetic reviewer', avatar_url: null },
    guest_author: null, replies: [], annotation: null, reactions: [], ...overrides,
  } as CommentWithReplies
}

function frame() {
  now += 1000 / 60
  const callbacks = [...rafs.values()]
  rafs.clear()
  act(() => callbacks.forEach((cb) => cb(now)))
}

function mount(props: { rightVersion?: AssetVersion; canComment?: boolean; canModerate?: boolean } = {}) {
  const cache = new Map()
  const tree = (next = props) => (
    <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
      <CompareOverlay asset={asset} versions={versions} rightVersion={versions[2]} onClose={onClose} {...next} />
    </SWRConfig>
  )
  const view = render(tree())
  return { ...view, update: (next: typeof props) => view.rerender(tree(next)) }
}

beforeEach(() => {
  search = 'compare=v-1'
  server = { 'v-1': [comment('left', 'v-1')], 'v-2': [comment('other', 'v-2')], 'v-3': [comment('right', 'v-3')] }
  useReviewStore.getState().reset()
  useAuthStore.setState({ user: { id: 'u1', name: 'Synthetic reviewer' } as never })
  rafs = new Map()
  rafId = 0
  now = performance.now()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafs.set(++rafId, cb); return rafId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => rafs.delete(id))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  Element.prototype.scrollIntoView = vi.fn()
  vi.mocked(api.get).mockImplementation(async (url) => {
    const versionId = new URL(String(url), 'http://test').searchParams.get('version_id')
    return (versionId ? server[versionId] ?? [] : []) as never
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('compare comment panels during real transport playback (#170)', () => {
  it.each([6, 18])('does not re-render either comment tree for %i animation frames', async (ticks) => {
    for (const v of ['v-1', 'v-3']) {
      server[v] = Array.from({ length: 10 }, (_, i) => comment(`${v}-${i}`, v))
      server[v][0].replies = [comment(`${v}-reply`, v, { parent_id: `${v}-0` })]
    }
    mount({ canComment: false })
    fireEvent.click(screen.getByLabelText('Toggle left comments'))
    await screen.findByText('v-1-reply')
    await screen.findByText('v-3-reply')
    // No audible master: the real transport advances by wall-clock rAF time.
    fireEvent.click(screen.getByLabelText('Mute v3'))
    fireEvent.keyDown(window, { key: ' ' })
    // Each real CommentItem calls this formatter once per render. The spy
    // calls through unchanged; CompareOverlay, CommentPanel, CommentItem,
    // useComments, SWR and useSyncedTransport are all real, with no StrictMode.
    const rows = vi.spyOn(utils, 'formatRelativeTime')
    const videos = document.querySelectorAll('video')
    const before = videos[0].currentTime
    now = performance.now()
    for (let i = 0; i < ticks; i++) frame()
    expect(videos[0].currentTime).toBeGreaterThan(before)
    expect(videos[1].currentTime).toBeGreaterThan(before)
    expect(rows).toHaveBeenCalledTimes(0)
  })

  it('keeps creates, replies, resolution, reactions and deletion live through the shared cache', async () => {
    mount()
    await screen.findByText('right')
    const row = (id: string) => within(screen.getByText(id).closest('[class~="group/comment"]') as HTMLElement)

    const added = comment('added', 'v-3')
    vi.mocked(api.post).mockImplementationOnce(async () => {
      server['v-3'] = [...server['v-3'], added]
      return added as never
    })
    fireEvent.change(screen.getByPlaceholderText('Leave your comment...'), { target: { value: 'added' } })
    fireEvent.click(screen.getByTitle('Send (Enter)'))
    await screen.findByText('added')
    expect(api.post).toHaveBeenLastCalledWith('/assets/a1/comments', expect.objectContaining({ body: 'added', version_id: 'v-3' }))

    const reply = comment('reply', 'v-3', { parent_id: 'right' })
    vi.mocked(api.post).mockImplementationOnce(async () => {
      server['v-3'] = server['v-3'].map((c) => c.id === 'right' ? { ...c, replies: [reply] } : c)
      return reply as never
    })
    fireEvent.click(row('right').getByText('Reply'))
    const replyInput = screen.getByPlaceholderText('Leave your reply here...')
    fireEvent.change(replyInput, { target: { value: 'reply' } })
    fireEvent.keyDown(replyInput, { key: 'Enter' })
    await screen.findByText('reply')
    expect(api.post).toHaveBeenLastCalledWith('/assets/a1/comments/right/replies', { body: 'reply', version_id: 'v-3', parent_id: 'right' })

    vi.mocked(api.post).mockImplementationOnce(async () => {
      server['v-3'] = server['v-3'].map((c) => c.id === 'added' ? { ...c, resolved: true } : c)
      return undefined as never
    })
    fireEvent.click(row('added').getByTitle('Resolve'))
    await waitFor(() => expect(row('added').getByTitle('Unresolve')).toBeEnabled())
    expect(api.post).toHaveBeenLastCalledWith('/comments/added/resolve')

    vi.mocked(api.post).mockImplementationOnce(async () => {
      server['v-3'] = server['v-3'].map((c) => c.id === 'added'
        ? { ...c, reactions: [{ id: 'reaction', user_id: 'u1', comment_id: 'added', emoji: '👍' }] as never }
        : c)
      return undefined as never
    })
    fireEvent.click(row('added').getByTitle('Add reaction'))
    fireEvent.click(row('added').getByRole('button', { name: '👍' }))
    await waitFor(() => expect(row('added').getByRole('button', { name: /^👍\s*1$/ })).toBeInTheDocument())
    expect(api.post).toHaveBeenLastCalledWith('/comments/added/react', { emoji: '👍' })

    vi.mocked(api.post).mockImplementationOnce(async () => {
      server['v-3'] = server['v-3'].map((c) => c.id === 'added' ? { ...c, reactions: [] } : c)
      return undefined as never
    })
    fireEvent.click(row('added').getByRole('button', { name: /^👍\s*1$/ }))
    await waitFor(() => expect(row('added').queryByRole('button', { name: /^👍\s*1$/ })).not.toBeInTheDocument())

    vi.mocked(api.delete).mockImplementationOnce(async () => {
      server['v-3'] = server['v-3'].filter((c) => c.id !== 'added')
      return undefined as never
    })
    fireEvent.click(row('added').getByLabelText('Comment actions'))
    fireEvent.click(row('added').getByText('Delete'))
    await waitFor(() => expect(screen.queryByText('added')).not.toBeInTheDocument())
    expect(api.delete).toHaveBeenCalledWith('/comments/added')
    expect(screen.getByText('right')).toBeInTheDocument()
    expect(screen.getByText('reply')).toBeInTheDocument()
  })

  it('updates versions and user/role permissions without retaining old reply routing', async () => {
    const view = mount({ canComment: false })
    await screen.findByText('right')
    expect(screen.queryByPlaceholderText('Leave your comment...')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Comment actions')).toBeInTheDocument()
    act(() => useAuthStore.setState({ user: { id: 'u2', name: 'Other reviewer' } as never }))
    expect(screen.queryByLabelText('Comment actions')).not.toBeInTheDocument()
    view.update({ canComment: true, canModerate: true, rightVersion: versions[1] })
    await screen.findByText('other')
    expect(screen.queryByText('right')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('Leave your comment...')).toBeInTheDocument()
    expect(screen.getByLabelText('Comment actions')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Comment actions'))
    expect(screen.getByText('Delete')).toBeInTheDocument()
    expect(screen.queryByText('Edit')).not.toBeInTheDocument()

    const reply = comment('new-version-reply', 'v-2', { parent_id: 'other' })
    vi.mocked(api.post).mockImplementationOnce(async () => {
      server['v-2'] = [{ ...server['v-2'][0], replies: [reply] }]
      return reply as never
    })
    fireEvent.click(screen.getByText('Reply'))
    const input = screen.getByPlaceholderText('Leave your reply here...')
    fireEvent.change(input, { target: { value: reply.body } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByText(reply.body)
    expect(api.post).toHaveBeenLastCalledWith('/assets/a1/comments/other/replies', { body: reply.body, version_id: 'v-2', parent_id: 'other' })
  })

  it.each(['a', 'b'] as const)('uses the latest offset and play state for pane %s comment/annotation clicks', async (side) => {
    const id = side === 'a' ? 'left' : 'right'
    const versionId = side === 'a' ? 'v-1' : 'v-3'
    server[versionId] = [comment(id, versionId, {
      annotation: { id: 'ann', comment_id: id, drawing_data: { objects: [] } },
    })]
    const view = mount({ canComment: false })
    fireEvent.click(screen.getByLabelText('Toggle left comments'))
    await screen.findByText(id)
    fireEvent.click(screen.getByLabelText('Mute v3'))
    // Change both offsets AFTER mounting the memo boundary.
    search = 'compare=v-1&offA=2&offB=3'
    view.update({ canComment: false })
    fireEvent.click(screen.getByLabelText('Play'))
    now = performance.now()
    frame()
    fireEvent.click(screen.getByText(id))
    expect(screen.getByLabelText('Play')).toBeInTheDocument()
    const videos = document.querySelectorAll('video')
    const own = side === 'a' ? videos[0] : videos[1]
    const other = side === 'a' ? videos[1] : videos[0]
    expect(own.currentTime).toBeCloseTo(5)
    expect(other.currentTime).toBeCloseTo(side === 'a' ? 4 : 6)
    // A paused re-click must stay paused (not toggle back into playing).
    fireEvent.click(screen.getByText(id))
    expect(screen.getByLabelText('Play')).toBeInTheDocument()
    // An annotation click after another offset change must use that change too.
    search = 'compare=v-1&offA=4&offB=1'
    view.update({ canComment: false })
    fireEvent.click(screen.getByLabelText('Play'))
    const pane = screen.getByText(id).closest('aside') as HTMLElement
    fireEvent.click(within(pane).getByTitle('Show annotation'))
    expect(screen.getByLabelText('Play')).toBeInTheDocument()
    expect(own.currentTime).toBeCloseTo(5)
    expect(other.currentTime).toBeCloseTo(side === 'a' ? 8 : 2)
    const overlays = screen.getAllByTestId('annotation-overlay')
    expect(overlays).toHaveLength(1)
    expect(overlays[0].parentElement?.parentElement).toContainElement(own)
  })

  it.each(['a', 'b'] as const)('pauses pane %s composer, timecode and marker clicks without resuming', async (side) => {
    mount()
    fireEvent.click(screen.getByLabelText('Toggle left comments'))
    const id = side === 'a' ? 'left' : 'right'
    await screen.findByText(id)
    const pane = screen.getByText(id).closest('aside') as HTMLElement
    fireEvent.click(screen.getByLabelText('Mute v3'))
    fireEvent.click(screen.getByLabelText('Play'))
    now = performance.now()
    for (let i = 0; i < 6; i++) frame()

    const input = within(pane).getByPlaceholderText('Leave your comment...')
    fireEvent.click(input)
    expect(screen.getByLabelText('Play')).toBeInTheDocument()
    fireEvent.click(input)
    expect(screen.getByLabelText('Play')).toBeInTheDocument()
    frame()
    const videos = document.querySelectorAll('video')
    const heldTimes = [...videos].map((v) => v.currentTime)
    frame()
    frame()
    expect([...videos].map((v) => v.currentTime)).toEqual(heldTimes)

    // The timecode button also reaches the row handler: both requests pause.
    fireEvent.click(screen.getByLabelText('Play'))
    fireEvent.click(within(pane).getByTitle('Jump to timecode'))
    expect(screen.getByLabelText('Play')).toBeInTheDocument()
    expect([...videos].map((v) => v.currentTime)).toEqual([5, 5])

    fireEvent.click(screen.getByLabelText('Play'))
    fireEvent.click(screen.getByTestId(`marker-${side}-${id}`))
    expect(screen.getByLabelText('Play')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId(`marker-${side}-${id}`))
    expect(screen.getByLabelText('Play')).toBeInTheDocument()
    frame()
    frame()
    expect([...videos].map((v) => v.currentTime)).toEqual([5, 5])
  })
})
