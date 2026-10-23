import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSyncedTransport, type SlavableVideo } from '../use-synced-transport'

const players = vi.hoisted(() => ({
  a: { videoRef: { current: null as unknown } },
  b: { videoRef: { current: null as unknown } },
}))
vi.mock('@/hooks/use-video-player', () => ({
  useVideoPlayer: (url: string) => url === 'a' ? players.a : players.b,
}))

// Model a decoder landing on the preceding frame rather than the exact seek
// time. A repeated assignment is observable even if it lands on the same frame.
function fakeVideo(fps: number): SlavableVideo & { seeks: number[] } {
  let currentTime = 8
  const seeks: number[] = []
  return {
    get currentTime() { return currentTime },
    set currentTime(time) {
      seeks.push(time)
      currentTime = Math.floor(time * fps) / fps
    },
    paused: true,
    play() { this.paused = false; return Promise.resolve() },
    pause() { this.paused = true },
    seeks,
  }
}

type Args = Parameters<typeof useSyncedTransport>[0]
let root: Root
let callbacks: Map<number, FrameRequestCallback>
let now: number

function mountTransport(fpsA: number | null, fpsB: number | null) {
  let current: ReturnType<typeof useSyncedTransport>
  function Probe(props: Args) {
    current = useSyncedTransport(props)
    return null
  }
  const args = {
    urlA: 'a', urlB: 'b',
    timingA: { offset: 0, duration: 60 },
    timingB: { offset: 0, duration: 60 },
    fpsA, fpsB,
  }
  const render = (props: Args) => act(() => root.render(createElement(Probe, props)))
  render(args)
  return {
    get current() { return current! },
    rerender: (next: Partial<Args>) => render({ ...args, ...next }),
  }
}

function frame() {
  now += 16
  const pending = [...callbacks.values()]
  callbacks.clear()
  act(() => pending.forEach((callback) => callback(now)))
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  callbacks = new Map()
  now = 0
  let id = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (key: number) => callbacks.delete(key))
  root = createRoot(document.createElement('div'))
})

afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useSyncedTransport native frame tolerances', () => {
  it.each([[24, 60], [60, 24]])('settles paused %ifps / %ifps panes independently', (fpsA, fpsB) => {
    const a = fakeVideo(fpsA)
    const b = fakeVideo(fpsB)
    players.a.videoRef.current = a
    players.b.videoRef.current = b
    const transport = mountTransport(fpsA, fpsB)

    act(() => transport.current.seekTo(8.02))
    frame()
    frame()
    frame()

    // 20ms is within one 24fps frame, but outside one 60fps frame. The
    // high-fps side seeks once and settles; the low-fps side never re-seeks.
    expect(a.seeks).toHaveLength(fpsA === 60 ? 1 : 0)
    expect(b.seeks).toHaveLength(fpsB === 60 ? 1 : 0)
  })

  it('updates the native tolerance after switching a pane to another frame rate', () => {
    const a = fakeVideo(24)
    const b = fakeVideo(60)
    players.a.videoRef.current = a
    players.b.videoRef.current = b
    const transport = mountTransport(24, 60)
    act(() => transport.current.seekTo(8.02))
    expect(a.seeks).toHaveLength(0)

    const replacement = fakeVideo(60)
    players.a.videoRef.current = replacement
    transport.rerender({ fpsA: 60 })
    frame()
    frame()
    expect(replacement.seeks).toHaveLength(1)
    expect(b.seeks).toHaveLength(1)
  })

  it('uses the unknown-fps fallback only for the pane with missing metadata', () => {
    const a = fakeVideo(25)
    const b = fakeVideo(60)
    players.a.videoRef.current = a
    players.b.videoRef.current = b
    const transport = mountTransport(null, 60)
    act(() => transport.current.seekTo(8.03))
    frame()
    frame()
    expect(a.seeks).toHaveLength(0)
    expect(b.seeks).toHaveLength(1)
  })
})
