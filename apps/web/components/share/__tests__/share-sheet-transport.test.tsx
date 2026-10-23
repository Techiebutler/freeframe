/**
 * The mobile comment sheet's play/pause button on a share link (#412).
 *
 * Everything here is real: ShareReviewScreen, ReviewProvider, VideoPlayer and
 * its useVideoPlayer, MobileCommentSheet and useMediaTransport. Only the
 * network, the viewport (a portrait phone, so the sheet is what shows) and the
 * three media methods jsdom does not implement are faked.
 *
 * Two things were wrong. The sheet's transport never attached its root ref,
 * so it never found the <video>: the button did nothing and always said Play.
 * And once attached, it drove the element directly, past the player hook, so
 * it had neither the iOS first-tap retry (#404) nor the disarm on pause.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'
import { ShareReviewScreen } from '../share-review-screen'

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

beforeEach(() => {
  useReviewStore.getState().reset()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/share/tok/stream/a1')) {
      return respond(200, { name: 'Clip.mp4', asset_type: 'video', url: 'http://example.test/v1.mp4', version_id: 'v1' })
    }
    if (url.includes('/share/tok/assets/a1/versions')) {
      return respond(200, [{ id: 'v1', version_number: 1, processing_status: 'ready', created_at: '' }])
    }
    if (url.includes('/share/tok/comments')) return respond(200, [])
    return respond(404, {})
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  // A portrait phone: no query matches, so no `md`, no landscape, no `sm`.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }))
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * jsdom implements neither play() nor pause(), and `paused` is read-only. This
 * follows the spec where it matters here: play() on a paused element flips
 * `paused` and fires `play` at once, before its promise settles, and pause()
 * fires `pause` and rejects a play() that is still pending with AbortError.
 */
function fakeMedia(video: HTMLVideoElement, playResult: (call: number) => 'resolve' | 'reject' | 'pending') {
  let paused = true
  let pendingReject: ((e: unknown) => void) | null = null
  Object.defineProperty(video, 'paused', { configurable: true, get: () => paused })
  const play = vi.fn(() => {
    const result = playResult(play.mock.calls.length)
    if (result === 'reject') return Promise.reject(new DOMException('no data', 'NotAllowedError'))
    if (paused) {
      paused = false
      video.dispatchEvent(new Event('play'))
    }
    if (result === 'resolve') return Promise.resolve()
    return new Promise<void>((_, reject) => { pendingReject = reject })
  })
  const pause = vi.fn(() => {
    if (!paused) {
      paused = true
      video.dispatchEvent(new Event('pause'))
    }
    pendingReject?.(new DOMException('interrupted by pause()', 'AbortError'))
    pendingReject = null
  })
  video.play = play
  video.pause = pause
  return { play, pause }
}

async function openOnPhone() {
  const view = render(
    <ShareReviewScreen
      token="tok" assetId="a1" assetName="Clip.mp4"
      permission="view" allowDownload={false} showVersions={false}
    />,
  )
  await waitFor(() => expect(view.container.querySelector('video')).not.toBeNull(), { timeout: 3000 })
  const video = view.container.querySelector('video') as HTMLVideoElement
  // At `peek` the player's own transport row is uncovered and the sheet shows
  // none; one tap up to `half` and it covers that row and shows its own.
  fireEvent.click(screen.getByRole('button', { name: 'Open comments' }))
  const sheet = within(screen.getByTestId('mobile-comment-sheet'))
  return { video, sheet }
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

describe('the sheet play/pause button on a share link', () => {
  it('plays the video and then says Pause', async () => {
    const { video, sheet } = await openOnPhone()
    const { play } = fakeMedia(video, () => 'resolve')

    fireEvent.click(sheet.getByRole('button', { name: 'Play' }))
    await flush()

    expect(play).toHaveBeenCalledTimes(1)
    expect(sheet.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('pauses a playing video and then says Play', async () => {
    const { video, sheet } = await openOnPhone()
    const { pause } = fakeMedia(video, () => 'resolve')

    fireEvent.click(sheet.getByRole('button', { name: 'Play' }))
    await flush()
    fireEvent.click(sheet.getByRole('button', { name: 'Pause' }))

    expect(pause).toHaveBeenCalledTimes(1)
    expect(sheet.getByRole('button', { name: 'Play' })).toBeInTheDocument()
  })

  // The iOS first tap (#404): play() rejects with nothing buffered, and the
  // player retries once on `canplay`. The sheet must get that retry too.
  it('retries a rejected first play() once the video can play', async () => {
    const { video, sheet } = await openOnPhone()
    const { play } = fakeMedia(video, (call) => (call === 1 ? 'reject' : 'resolve'))

    fireEvent.click(sheet.getByRole('button', { name: 'Play' }))
    await flush()
    expect(play).toHaveBeenCalledTimes(1)

    act(() => { video.dispatchEvent(new Event('canplay')) })
    await flush()

    expect(play).toHaveBeenCalledTimes(2)
    expect(sheet.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  // A pause from the sheet while the player's own play() is still pending.
  // That play() rejects with AbortError after the pause; the pause has to end
  // the intent to play, or the rejection arms a retry and `canplay` resumes a
  // video the user just paused.
  it('does not resume a video paused from the sheet while play() was pending', async () => {
    const { video, sheet } = await openOnPhone()
    const { play, pause } = fakeMedia(video, () => 'pending')

    // The player's own button, under the sheet: the one outside it.
    const playerPlay = screen.getAllByRole('button', { name: 'Play' })
      .find((b) => !screen.getByTestId('mobile-comment-sheet').contains(b))!
    fireEvent.click(playerPlay)
    await flush()
    expect(play).toHaveBeenCalledTimes(1)

    fireEvent.click(sheet.getByRole('button', { name: 'Pause' }))
    await flush()
    expect(pause).toHaveBeenCalledTimes(1)

    act(() => { video.dispatchEvent(new Event('canplay')) })
    await flush()

    expect(play).toHaveBeenCalledTimes(1)
    expect(video.paused).toBe(true)
    expect(sheet.getByRole('button', { name: 'Play' })).toBeInTheDocument()
  })
})
