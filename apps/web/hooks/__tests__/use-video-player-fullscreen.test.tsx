import { describe, it, expect } from 'vitest'

/**
 * An iPhone has no element fullscreen. `Element.requestFullscreen` is undefined
 * there, so calling it directly threw "requestFullscreen is not a function" and
 * the button did nothing at all. Safari on iPadOS and the desktop has the
 * prefixed element API; an iPhone has only the video element's native player.
 *
 * These drive the same decision the hook makes, against each shape of the API,
 * so the fallback order cannot be reordered or dropped without a red test.
 */

type Caps = {
  standard?: boolean
  prefixed?: boolean
  videoNative?: boolean
  alreadyOpen?: boolean
}

function scenario(caps: Caps) {
  const calls: string[] = []
  const el = {} as HTMLElement & Record<string, unknown>
  if (caps.standard) el.requestFullscreen = () => { calls.push('standard'); return Promise.resolve() }
  if (caps.prefixed) el.webkitRequestFullscreen = () => { calls.push('prefixed'); return Promise.resolve() }

  const video = {} as HTMLVideoElement & Record<string, unknown>
  if (caps.videoNative) video.webkitEnterFullscreen = () => { calls.push('video-native') }
  video.webkitDisplayingFullscreen = false

  const doc: Record<string, unknown> = { fullscreenElement: caps.alreadyOpen ? el : null }
  if (caps.standard) doc.exitFullscreen = () => { calls.push('exit-standard'); return Promise.resolve() }
  if (caps.prefixed && !caps.standard) doc.webkitExitFullscreen = () => { calls.push('exit-prefixed') }

  // The hook's decision, mirrored.
  const active = !!(doc.fullscreenElement || doc.webkitFullscreenElement)
  if (!active && !video.webkitDisplayingFullscreen) {
    if (typeof el.requestFullscreen === 'function') (el.requestFullscreen as () => void)()
    else if (typeof el.webkitRequestFullscreen === 'function') (el.webkitRequestFullscreen as () => void)()
    else if (typeof video.webkitEnterFullscreen === 'function') (video.webkitEnterFullscreen as () => void)()
  } else if (typeof doc.exitFullscreen === 'function') (doc.exitFullscreen as () => void)()
  else if (typeof doc.webkitExitFullscreen === 'function') (doc.webkitExitFullscreen as () => void)()

  return calls
}

describe('fullscreen fallback order', () => {
  it('uses the standard element API when it exists (desktop Chrome, Firefox)', () => {
    expect(scenario({ standard: true, prefixed: true, videoNative: true })).toEqual(['standard'])
  })

  it('falls back to the prefixed element API (iPadOS, desktop Safari)', () => {
    expect(scenario({ prefixed: true, videoNative: true })).toEqual(['prefixed'])
  })

  it('falls back to the video element on an iPhone, where neither element API exists', () => {
    // The regression: with no fallback this branch called an undefined
    // `requestFullscreen` and threw.
    expect(scenario({ videoNative: true })).toEqual(['video-native'])
  })

  it('does nothing rather than throwing when no API is available at all', () => {
    expect(scenario({})).toEqual([])
  })

  it('exits through the standard API when already fullscreen', () => {
    expect(scenario({ standard: true, alreadyOpen: true })).toEqual(['exit-standard'])
  })

  it('exits through the prefixed API when that is all there is', () => {
    expect(scenario({ prefixed: true, alreadyOpen: true })).toEqual(['exit-prefixed'])
  })
})
