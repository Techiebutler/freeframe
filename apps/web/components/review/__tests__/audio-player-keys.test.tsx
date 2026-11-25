import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react'

// Space plays and pauses the audio player, except where an open menu or
// dialog uses it to pick an item (#419): the version switcher's ⋯ sits over
// the player on the review page.
const ws = vi.hoisted(() => ({
  playPause: vi.fn(),
  on: vi.fn(), load: vi.fn(), destroy: vi.fn(), getDuration: () => 10,
  setVolume: vi.fn(), setPlaybackRate: vi.fn(), seekTo: vi.fn(), play: vi.fn(),
}))
vi.mock('wavesurfer.js', () => ({ default: { create: vi.fn(() => ws) } }))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(async () => ({ url: 'audio.mp3' })) } }))
vi.mock('@/components/review/review-provider', () => ({
  useReview: () => ({ shareToken: undefined, shareSession: undefined }),
}))

import WaveSurfer from 'wavesurfer.js'
import { AudioPlayer } from '../audio-player'

const asset = { id: 'a1', name: 'Mix', asset_type: 'audio' } as unknown as React.ComponentProps<typeof AudioPlayer>['asset']
const version = { id: 'v1', version_number: 1 } as unknown as React.ComponentProps<typeof AudioPlayer>['version']

beforeEach(() => {
  ws.playPause.mockClear()
})

describe('Space in the audio player', () => {
  it('leaves Space pressed in an open menu to the menu, and plays otherwise', async () => {
    render(<AudioPlayer asset={asset} version={version} />)
    await waitFor(() => expect(WaveSurfer.create).toHaveBeenCalled())
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('div')
    menu.appendChild(item)
    document.body.appendChild(menu)

    fireEvent.keyDown(item, { code: 'Space' })
    expect(ws.playPause).not.toHaveBeenCalled()

    fireEvent.keyDown(document.body, { code: 'Space' })
    expect(ws.playPause).toHaveBeenCalledTimes(1)
    menu.remove()
  })
})
