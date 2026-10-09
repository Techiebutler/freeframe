import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useReviewStore } from '@/stores/review-store'
import { useVideoPlayer, type UseVideoPlayerReturn } from '../use-video-player'

const hls = vi.hoisted(() => {
  const instances: Array<{
    currentLevel: number
    emit: (event: string, data: unknown) => void
  }> = []
  const Events = {
    MANIFEST_PARSED: 'manifestParsed',
    ERROR: 'error',
    LEVEL_SWITCHED: 'levelSwitched',
  }

  class FakeHls {
    static Events = Events
    static isSupported = vi.fn(() => true)
    currentLevel = -1
    private handlers = new Map<string, (event: string, data: unknown) => void>()

    constructor() {
      instances.push(this)
    }

    on(event: string, callback: (event: string, data: unknown) => void) {
      this.handlers.set(event, callback)
    }

    emit(event: string, data: unknown) {
      this.handlers.get(event)?.(event, data)
    }

    loadSource() {}
    attachMedia() {}
    destroy() {}
    startLoad() {}
  }

  return { Events, FakeHls, instances }
})

vi.mock('hls.js', () => ({
  default: hls.FakeHls,
  Events: hls.Events,
}))

const SRC = 'http://example.test/video.m3u8'

function renderPlayer() {
  let player!: UseVideoPlayerReturn

  function Harness() {
    player = useVideoPlayer(SRC)
    return <video ref={player.videoRef} />
  }

  const view = render(<Harness />)
  return { view, get player() { return player }, instance: hls.instances[0] }
}

beforeEach(() => {
  hls.instances.length = 0
  useReviewStore.getState().reset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useVideoPlayer quality selection', () => {
  it('keeps the selected Auto mode separate from HLS level switches', () => {
    const rendered = renderPlayer()
    const instance = rendered.instance
    expect(rendered.player.selectedQuality).toBe(-1)
    expect(rendered.player.currentQuality).toBe(-1)

    act(() => {
      instance.emit(hls.Events.MANIFEST_PARSED, {
        levels: [
          { height: 1080, bitrate: 5_000_000 },
          { height: 720, bitrate: 2_500_000 },
        ],
      })
    })
    act(() => instance.emit(hls.Events.LEVEL_SWITCHED, { level: 0 }))

    expect(rendered.player.currentQuality).toBe(0)
    expect(rendered.player.selectedQuality).toBe(-1)

    act(() => rendered.player.setQuality(1))
    expect(instance.currentLevel).toBe(1)
    expect(rendered.player.currentQuality).toBe(0)
    expect(rendered.player.selectedQuality).toBe(1)

    act(() => instance.emit(hls.Events.LEVEL_SWITCHED, { level: 1 }))
    expect(rendered.player.currentQuality).toBe(1)
    expect(rendered.player.selectedQuality).toBe(1)

    act(() => rendered.player.setQuality(-1))
    act(() => instance.emit(hls.Events.LEVEL_SWITCHED, { level: 0 }))
    expect(rendered.player.currentQuality).toBe(0)
    expect(rendered.player.selectedQuality).toBe(-1)
  })
})
