import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useReviewStore } from '@/stores/review-store'
import { savedBandwidth, saveBandwidth } from '@/lib/hls-bandwidth'
import { useVideoPlayer } from '../use-video-player'

const hls = vi.hoisted(() => {
  const instances: Array<{
    config: Record<string, unknown>
    bandwidthEstimate: number
    emit: (event: string, data: unknown) => void
  }> = []
  const Events = {
    MANIFEST_PARSED: 'manifestParsed',
    ERROR: 'error',
    LEVEL_SWITCHED: 'levelSwitched',
    FRAG_BUFFERED: 'fragBuffered',
  }

  return { Events, instances }
})

// Captures the config each player builds hls.js with, and lets a test set
// the bandwidth estimate hls.js would report.
vi.mock('hls.js', async () => {
  const { Events, instances } = hls
  class FakeHls {
    static Events = Events
    static isSupported = () => true
    bandwidthEstimate = 0
    private handlers = new Map<string, (event: string, data: unknown) => void>()
    constructor(public config: Record<string, unknown>) {
      instances.push(this as never)
    }
    on(event: string, cb: (event: string, data: unknown) => void) { this.handlers.set(event, cb) }
    emit(event: string, data: unknown) { this.handlers.get(event)?.(event, data) }
    loadSource() {}
    attachMedia() {}
    destroy() {}
    startLoad() {}
  }
  return { default: FakeHls, Events }
})

function Harness({ detached = false }: { detached?: boolean }) {
  const player = useVideoPlayer('http://example.test/video.m3u8', { detached })
  return <video ref={player.videoRef} />
}

function frag(overrides: Record<string, unknown> = {}) {
  return { frag: { type: 'main', sn: 3, stats: { aborted: false }, ...overrides } }
}

beforeEach(() => {
  hls.instances.length = 0
  window.localStorage.clear()
  useReviewStore.getState().reset()
})

describe('useVideoPlayer starting quality', () => {
  it('starts Auto from the bandwidth measured last time', () => {
    saveBandwidth(15_000_000)
    render(<Harness />)

    expect(hls.instances[0].config.abrEwmaDefaultEstimate).toBe(15_000_000)
  })

  it('leaves a first-time viewer on hls.js\'s own first guess', () => {
    render(<Harness />)

    expect(hls.instances[0].config).not.toHaveProperty('abrEwmaDefaultEstimate')
    expect(hls.instances[0].config).not.toHaveProperty('abrEwmaDefaultEstimateMax')
  })

  it('saves the estimate after each buffered video segment', () => {
    render(<Harness />)
    const instance = hls.instances[0]

    instance.bandwidthEstimate = 18_000_000
    act(() => instance.emit(hls.Events.FRAG_BUFFERED, frag()))

    expect(savedBandwidth()).toBe(18_000_000)
  })

  it('ignores audio, init segments and aborted loads', () => {
    render(<Harness />)
    const instance = hls.instances[0]
    instance.bandwidthEstimate = 18_000_000

    act(() => {
      instance.emit(hls.Events.FRAG_BUFFERED, frag({ type: 'audio' }))
      instance.emit(hls.Events.FRAG_BUFFERED, frag({ sn: 'initSegment' }))
      instance.emit(hls.Events.FRAG_BUFFERED, frag({ stats: { aborted: true } }))
    })

    expect(savedBandwidth()).toBeUndefined()
  })

  it('does not save from a compare pane, which measures only its share of the link', () => {
    saveBandwidth(15_000_000, Date.now())
    render(<Harness detached />)
    const instance = hls.instances[0]

    instance.bandwidthEstimate = 7_000_000
    act(() => instance.emit(hls.Events.FRAG_BUFFERED, frag()))

    expect(savedBandwidth()).toBe(15_000_000)
  })
})
