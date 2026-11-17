import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// A guest on a share page gets the version switcher to change versions, and
// nothing else: no ⋯ per version, so no delete or restore, and no request for
// the deleted versions (#419). The switcher only offers those with
// `canDelete`, so the share screen must never pass it.
const { switcherProps } = vi.hoisted(() => ({ switcherProps: [] as Array<Record<string, unknown>> }))
vi.mock('@/components/review/version-switcher', () => ({
  VersionSwitcher: (props: Record<string, unknown>) => {
    switcherProps.push(props)
    return <div>version switcher</div>
  },
}))

import { FolderShareViewer } from '../folder-share-viewer'

describe('share review — the version switcher has no actions', () => {
  beforeEach(() => {
    switcherProps.length = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes('/versions')
        ? [
            { id: 'v2', asset_id: 'a1', version_number: 2, processing_status: 'ready', created_at: '' },
            { id: 'v1', asset_id: 'a1', version_number: 1, processing_status: 'ready', created_at: '' },
          ]
        : {
            assets: [{ id: 'a1', name: 'Clip.mp4', asset_type: 'video', latest_version_id: 'v2', thumbnail_url: null, status: 'ready' }],
            subfolders: [],
            total: 1,
          }),
    })) as unknown as typeof fetch)
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('renders the switcher for a link that shows versions, without canDelete', async () => {
    render(
      <FolderShareViewer
        token="t" folderName="F" title="T" description={null}
        permission="comment" allowDownload={false} showVersions
        appearance={{ open_in_viewer: true } as never} branding={null}
      />,
    )

    await waitFor(() => expect(screen.getByText('Clip.mp4')).toBeInTheDocument())
    fireEvent.doubleClick(screen.getByText('Clip.mp4'))

    await waitFor(() => expect(switcherProps.length).toBeGreaterThan(0), { timeout: 3000 })
    for (const props of switcherProps) {
      expect(props.canDelete).toBeFalsy()
      expect(props.onVersionsChanged).toBeUndefined()
    }
    const calls = vi.mocked(fetch).mock.calls.map(([u]) => String(u))
    expect(calls.some((u) => u.includes('deleted-versions'))).toBe(false)
  })
})
