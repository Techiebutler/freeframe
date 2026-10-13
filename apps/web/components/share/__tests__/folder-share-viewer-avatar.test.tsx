/**
 * A signed-in viewer sees their own picture in the folder share header, or
 * their initials on their own circle colour. It used to be initials on a
 * fixed green circle for everyone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FolderShareViewer } from '../folder-share-viewer'

/** jsdom never loads images, so Radix Avatar would stay on the fallback. */
class LoadedImage {
  complete = true
  naturalWidth = 1
  src = ''
  referrerPolicy = ''
  crossOrigin: string | null = null
  addEventListener() {}
  removeEventListener() {}
}

function renderViewer(props: { viewerAvatarUrl?: string | null; viewerAvatarColor?: string | null }) {
  return render(
    <FolderShareViewer
      token="t" folderName="F" title="T" description={null}
      viewerName="Ada Lovelace"
      {...props}
      permission="view" allowDownload={false} showVersions={false}
      appearance={{ open_in_viewer: true } as never} branding={null}
    />,
  )
}

describe('the viewer avatar in the folder share header', () => {
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
    vi.stubGlobal('Image', LoadedImage)
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('shows their picture', () => {
    renderViewer({ viewerAvatarUrl: 'https://s3.test/avatars/u1/pic.webp' })

    const img = screen.getByAltText('Ada Lovelace') as HTMLImageElement
    expect(img.src).toBe('https://s3.test/avatars/u1/pic.webp')
  })

  it('falls back to initials on their circle colour', () => {
    renderViewer({ viewerAvatarColor: '#a1b2c3' })

    const initials = screen.getByText('AL')
    const circle = initials.closest('span[style]') as HTMLElement
    expect(circle.style.backgroundColor).toBe('rgb(161, 178, 195)')
  })
})
