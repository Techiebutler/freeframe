import { describe, it, expect, vi } from 'vitest'
import * as React from 'react'
import { render, act } from '@testing-library/react'
import { useMediaTransport, type MediaTransport } from '../use-media-transport'

/**
 * The transport behind the mobile comment sheet's play/pause button (#412).
 *
 * A <video> is toggled through the player, so the sheet shares its iOS
 * first-tap retry and the disarm on pause. An <audio> has no such hook and
 * is driven directly, which also keeps WaveSurfer in step.
 */

let transport: MediaTransport

function Harness({ kind, toggleVideo }: { kind: 'video' | 'audio' | 'none'; toggleVideo?: () => void }) {
  transport = useMediaTransport({ toggleVideo })
  return (
    <div ref={transport.mediaRootRef} data-testid="root">
      {kind === 'video' && <video data-testid="media" />}
      {kind === 'audio' && <audio data-testid="media" />}
    </div>
  )
}

function stubMedia(el: HTMLMediaElement, play: () => Promise<void> = () => Promise.resolve()) {
  const playSpy = vi.fn(play)
  const pauseSpy = vi.fn()
  el.play = playSpy
  el.pause = pauseSpy
  Object.defineProperty(el, 'paused', { configurable: true, get: () => true })
  return { play: playSpy, pause: pauseSpy }
}

describe('useMediaTransport', () => {
  it('toggles a <video> through the player, never the element', () => {
    const toggleVideo = vi.fn()
    const view = render(<Harness kind="video" toggleVideo={toggleVideo} />)
    const { play, pause } = stubMedia(view.getByTestId('media') as HTMLVideoElement)

    act(() => transport.togglePlay())

    expect(toggleVideo).toHaveBeenCalledTimes(1)
    expect(play).not.toHaveBeenCalled()
    expect(pause).not.toHaveBeenCalled()
  })

  it('plays an <audio> directly and swallows a rejected play()', async () => {
    const toggleVideo = vi.fn()
    const view = render(<Harness kind="audio" toggleVideo={toggleVideo} />)
    const audio = view.getByTestId('media') as HTMLAudioElement
    stubMedia(audio)
    // A plain function, not vi.fn(): a spy records how its returned promise
    // settles, and in doing so handles the rejection this is looking for.
    let plays = 0
    audio.play = () => {
      plays += 1
      return Promise.reject(new DOMException('blocked', 'NotAllowedError'))
    }
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    act(() => transport.togglePlay())
    await new Promise((r) => setTimeout(r, 0))
    process.off('unhandledRejection', unhandled)

    expect(plays).toBe(1)
    expect(toggleVideo).not.toHaveBeenCalled()
    expect(unhandled).not.toHaveBeenCalled()
  })

  it("follows the element's own play and pause events", () => {
    const view = render(<Harness kind="video" toggleVideo={vi.fn()} />)
    const video = view.getByTestId('media') as HTMLVideoElement
    expect(transport.isPlaying).toBe(false)

    act(() => { video.dispatchEvent(new Event('play')) })
    expect(transport.isPlaying).toBe(true)

    act(() => { video.dispatchEvent(new Event('pause')) })
    expect(transport.isPlaying).toBe(false)
  })

  // The player mounts after the column does: a stream URL fetch, a dynamic
  // import, a version switch replacing the element.
  it('finds a player that mounts after the column', async () => {
    const toggleVideo = vi.fn()
    const view = render(<Harness kind="none" toggleVideo={toggleVideo} />)
    act(() => transport.togglePlay())
    expect(toggleVideo).not.toHaveBeenCalled()

    view.rerender(<Harness kind="video" toggleVideo={toggleVideo} />)
    // MutationObserver callbacks run as a microtask.
    await act(async () => { await Promise.resolve() })
    act(() => transport.togglePlay())

    expect(toggleVideo).toHaveBeenCalledTimes(1)
  })
})
