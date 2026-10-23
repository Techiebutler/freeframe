import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { ShareLinkListItem } from '@/types'

const post = vi.fn()
const copyToClipboard = vi.fn()
const mutateShareLinks = vi.fn()
const useShareLinks = vi.fn()

vi.mock('@/lib/api', () => ({ api: { post: (...a: unknown[]) => post(...a) } }))
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  copyToClipboard: (...a: unknown[]) => copyToClipboard(...a),
}))
vi.mock('@/hooks/use-share-links', () => ({
  useShareLinks: (...a: unknown[]) => useShareLinks(...a),
}))
vi.mock('@/components/projects/share-create-dialog', () => ({ ShareCreateDialog: () => null }))

import { ShareDialog } from '../share-dialog'

function link(title: string, contains_asset: ShareLinkListItem['contains_asset']): ShareLinkListItem {
  return {
    id: `id-${title}`,
    token: `tok-${title}`,
    title,
    description: null,
    is_enabled: true,
    permission: 'view',
    share_type: 'asset',
    target_name: title,
    view_count: 0,
    last_viewed_at: null,
    created_at: '',
    contains_asset,
  }
}

const links = [
  link('Trailer cut', 'direct'),
  link('Whole project', 'indirect'),
  link('Other video', null),
]

function open() {
  render(<ShareDialog assetId="asset-1" assetName="trailer.mp4" projectId="proj-1" />)
  fireEvent.click(screen.getByRole('button', { name: /^share$/i }))
}

beforeEach(() => {
  post.mockReset()
  copyToClipboard.mockReset().mockResolvedValue(true)
  mutateShareLinks.mockReset()
  useShareLinks.mockReset().mockReturnValue({ shareLinks: links, isLoading: false, mutateShareLinks })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ShareDialog on an asset (#470)', () => {
  it('asks the list about this asset', () => {
    open()
    expect(useShareLinks).toHaveBeenCalledWith('proj-1', 'asset-1')
  })

  it('lists the links that already show the asset apart from the ones it can be added to', () => {
    open()
    const current = screen.getByRole('region', { name: 'Links to this asset' })
    const others = screen.getByRole('region', { name: 'Add to another share link' })

    expect(within(current).getByText('Trailer cut')).toBeInTheDocument()
    expect(within(current).getByText('Whole project')).toBeInTheDocument()
    expect(within(current).queryByText('Other video')).toBeNull()

    expect(within(others).getByText('Other video')).toBeInTheDocument()
    expect(within(others).queryByText('Trailer cut')).toBeNull()
    expect(within(others).queryByText('Whole project')).toBeNull()
  })

  it('says which links show the asset only indirectly, and which are switched off', () => {
    useShareLinks.mockReturnValue({
      shareLinks: [...links, { ...link('Old cut', 'direct'), is_enabled: false }],
      isLoading: false,
      mutateShareLinks,
    })
    open()
    const current = screen.getByRole('region', { name: 'Links to this asset' })

    expect(within(current).getAllByText('Through a folder or the whole project')).toHaveLength(1)
    expect(within(current).getByText('Access disabled')).toBeInTheDocument()
  })

  it('copies the share URL of a link that already shows the asset, without adding anything', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Copy link Trailer cut' }))

    await waitFor(() =>
      expect(copyToClipboard).toHaveBeenCalledWith(`${window.location.origin}/share/tok-Trailer cut`),
    )
    expect(post).not.toHaveBeenCalled()
    expect(await screen.findByText('Copied')).toBeInTheDocument()
  })

  it('reports success only when the API says the asset was added', async () => {
    post.mockResolvedValue({ detail: 'Asset added to share link', added: true })
    open()
    fireEvent.click(screen.getByRole('button', { name: /Other video/ }))

    expect(post).toHaveBeenCalledWith('/share/tok-Other video/add-asset/asset-1', {})
    expect(await screen.findByText('Added to this link')).toBeInTheDocument()
    expect(mutateShareLinks).toHaveBeenCalled()
  })

  it('says so when the link already had the asset', async () => {
    post.mockResolvedValue({ detail: 'Asset already included in this share link', added: false })
    open()
    fireEvent.click(screen.getByRole('button', { name: /Other video/ }))

    expect(await screen.findByText('Already in this link')).toBeInTheDocument()
    expect(screen.queryByText('Added to this link')).toBeNull()
  })

  it('shows the error when the add is refused', async () => {
    post.mockRejectedValue(new Error('Insufficient permissions'))
    open()
    fireEvent.click(screen.getByRole('button', { name: /Other video/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Insufficient permissions')
    expect(screen.queryByText('Added to this link')).toBeNull()
  })

  it("does not let an earlier add's reset wipe a later add's error", async () => {
    vi.useFakeTimers()
    useShareLinks.mockReturnValue({
      shareLinks: [...links, link('Second video', null)],
      isLoading: false,
      mutateShareLinks,
    })
    post
      .mockResolvedValueOnce({ detail: 'Asset added to share link', added: true })
      .mockRejectedValueOnce(new Error('Insufficient permissions'))
    open()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Other video/ }))
    })
    expect(screen.getByText('Added to this link')).toBeInTheDocument()

    // Within the first add's 2 s, a second add is refused.
    await act(async () => {
      vi.advanceTimersByTime(1000)
      fireEvent.click(screen.getByRole('button', { name: /Second video/ }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Insufficient permissions')

    // Past the first add's reset: the error is still there.
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Insufficient permissions')
  })

  it("does not let an earlier copy's reset clear a later copy's state early", async () => {
    vi.useFakeTimers()
    open()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link Trailer cut' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(1500)
      fireEvent.click(screen.getByRole('button', { name: 'Copy link Whole project' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    // 2.5 s after the first copy, 1 s after the second: the second still shows Copied.
    expect(screen.getByRole('button', { name: 'Copy link Whole project' })).toHaveTextContent('Copied')
    expect(screen.getByRole('button', { name: 'Copy link Trailer cut' })).toHaveTextContent(/^Copy$/)
  })
})
