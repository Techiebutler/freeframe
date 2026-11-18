import { describe, it, expect, vi } from 'vitest'
import * as React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DownloadMenu } from '../download-menu'
import type { DownloadOption } from '@/types'

const OPTIONS: DownloadOption[] = [
  { id: 'original', label: 'Original', format: 'MOV', size_bytes: 5 * 1024 ** 3 },
  { id: 'transcode', label: '1080p', format: 'MP4', size_bytes: null },
]

function renderMenu(load: () => Promise<DownloadOption[] | null>) {
  const onPick = vi.fn()
  render(
    <DownloadMenu load={load} onPick={onPick}>
      <button>Download</button>
    </DownloadMenu>,
  )
  return onPick
}

describe('DownloadMenu', () => {
  it('asks for the options only once it is opened', async () => {
    const load = vi.fn().mockResolvedValue(OPTIONS)
    renderMenu(load)
    expect(load).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('lists the original and the transcode, and downloads the one picked', async () => {
    const onPick = renderMenu(vi.fn().mockResolvedValue(OPTIONS))
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))

    expect(await screen.findByText('Original')).toBeTruthy()
    expect(screen.getByText('MOV · 5 GB')).toBeTruthy()
    // A size storage would not give is left out rather than shown as nothing.
    expect(screen.getByText('MP4')).toBeTruthy()

    await userEvent.click(screen.getByText('Original'))
    expect(onPick).toHaveBeenCalledWith('original')
  })

  it('still downloads when the options cannot be had', async () => {
    const onPick = renderMenu(vi.fn().mockRejectedValue(new Error('offline')))
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))

    const fallback = await screen.findByRole('menuitem', { name: 'Download' })
    await userEvent.click(fallback)
    // No choice named: the server serves what a download always served.
    await waitFor(() => expect(onPick).toHaveBeenCalledWith())
  })

  it('moves keyboard focus to the first option once the options arrive', async () => {
    // Opened from the keyboard before the list loads, Radix focuses the menu
    // itself; Enter must still pick something without an arrow key first.
    let resolve!: (o: DownloadOption[]) => void
    const onPick = renderMenu(() => new Promise((r) => { resolve = r }))
    screen.getByRole('button', { name: 'Download' }).focus()
    await userEvent.keyboard('{Enter}')
    await screen.findByText('Loading…')

    resolve(OPTIONS)

    const first = await screen.findByRole('menuitem', { name: /Original/ })
    await waitFor(() => expect(document.activeElement).toBe(first))
    await userEvent.keyboard('{Enter}')
    expect(onPick).toHaveBeenCalledWith('original')
  })
})
