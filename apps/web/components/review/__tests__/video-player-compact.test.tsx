import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn().mockResolvedValue({ url: 'x.mp4' }) } }))
vi.mock('@/hooks/use-video-player', () => ({
  useVideoPlayer: () => ({
    videoRef: { current: null }, isPlaying: false, isMuted: false, volume: 1, playbackRate: 1, currentTime: 3, duration: 10, buffered: 0,
    isLoading: false, error: null, qualityLevels: [{ index: 0, label: '720p' }], currentQuality: -1,
    togglePlay: vi.fn(), seek: vi.fn(), toggleMute: vi.fn(), setPlaybackRate: vi.fn(), setQuality: vi.fn(), setVolume: vi.fn(), play: vi.fn(), pause: vi.fn(),
  }),
}))
vi.mock('../progress-bar', () => ({ ProgressBar: () => <div data-testid="scrubber" /> }))
import { VideoPlayer } from '../video-player'

afterEach(cleanup)

describe('VideoPlayer compact (phone Flow view)', () => {
  it('keeps play, scrubber and time; loop, speed, volume, quality and fullscreen go behind one more button', () => {
    render(<VideoPlayer assetId="a" initialStreamUrl="x.mp4" compact />)
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
    expect(screen.getByTestId('scrubber')).toBeInTheDocument()
    for (const name of ['Loop', 'Playback speed', 'Mute', 'Quality', 'Enter fullscreen']) {
      expect(screen.queryByRole(name === 'Quality' ? 'combobox' : 'button', { name })).not.toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: 'More playback options' }))
    expect(screen.getByRole('button', { name: 'Loop' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Playback speed' })).toBeInTheDocument()
  })
  it('draws one marker per note under the scrubber and a tap seeks there', () => {
    render(<VideoPlayer assetId="a" initialStreamUrl="x.mp4" compact markers={[{ t: 2, label: '0:02.0' }, { t: 7.5, label: '0:07.5' }]} />)
    const row = screen.getByTestId('note-markers')
    expect(row.querySelectorAll('button')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Note at 0:07.5' })).toBeInTheDocument()
  })
  it('the full player still shows everything', () => {
    render(<VideoPlayer assetId="a" initialStreamUrl="x.mp4" />)
    expect(screen.getByRole('button', { name: 'Loop' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enter fullscreen' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More playback options' })).not.toBeInTheDocument()
  })
})
