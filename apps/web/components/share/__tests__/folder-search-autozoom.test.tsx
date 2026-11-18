/**
 * iOS Safari zooms the page when focus lands on a text input under 16px. The
 * folder browser's search box was `text-sm`, so a guest tapping it on an
 * iPhone got the page zoomed in. Same guard as the review inputs in #324.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { FolderShareViewer } from '../folder-share-viewer'

describe('the share-link folder search box', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ assets: [], subfolders: [], total: 0 }),
    })) as unknown as typeof fetch)
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('sizes the input at the 16px iOS zoom threshold, compact only under a hover query', async () => {
    render(
      <FolderShareViewer
        token="t" folderName="F" title="T" description={null}
        permission="view" allowDownload={false} showVersions={false}
        appearance={{ open_in_viewer: true } as never} branding={null}
      />,
    )

    const input = await screen.findByPlaceholderText('Search assets…')
    await waitFor(() => expect(input).toBeInTheDocument())
    const classes = input.className.split(/\s+/)
    expect(classes).toContain('text-[16px]')
    expect(classes).toContain('[@media(hover:hover)]:text-sm')
    expect(classes).not.toContain('text-sm')
    expect(input.className).not.toMatch(/\bmd:text-/)
  })
})
