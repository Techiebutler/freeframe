import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ShareReviewScreen } from '../share-review-screen'
import { resetShareRequestState } from '@/lib/share-request'
import { useReviewStore } from '@/stores/review-store'
import type { AssetVersion } from '@/types'

// Download on a share link serves the version on screen (#671). With "Show all
// versions" a guest could switch to v1 while Download, in the same top bar,
// still handed out the newest ready version under the same name.

// The real switcher is a Radix menu; all this needs is a way to change the
// version on screen, which is what picking a row in it does.
vi.mock('@/components/review/version-switcher', () => ({
  VersionSwitcher: ({ versions }: { versions: AssetVersion[] }) => (
    <div>
      {versions.map((v) => (
        <button key={v.id} onClick={() => useReviewStore.getState().setCurrentVersion(v)}>
          Show v{v.version_number}
        </button>
      ))}
    </div>
  ),
}))

const VERSIONS = [
  { id: 'v2', asset_id: 'a1', version_number: 2, processing_status: 'ready', created_at: '2026-11-20T10:00:00Z' },
  { id: 'v1', asset_id: 'a1', version_number: 1, processing_status: 'ready', created_at: '2026-11-18T10:00:00Z' },
]

let requests: URL[]

beforeEach(() => {
  localStorage.clear()
  resetShareRequestState()
  requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input)
      requests.push(url)
      if (url.pathname.endsWith('/auth/refresh')) {
        return { ok: false, status: 401, json: async () => ({ detail: 'Invalid refresh token' }) }
      }
      let body: unknown = {}
      if (url.pathname.endsWith('/stream/a1')) {
        body = { name: 'Still.png', asset_type: 'image', version_id: 'v2', url: 'https://cdn.example/still.png' }
      } else if (url.pathname.endsWith('/assets/a1/versions')) {
        body = VERSIONS
      } else if (url.pathname.endsWith('/downloads/a1')) {
        body = [{ id: 'original', label: 'Original', format: 'PNG', size_bytes: 13_000_000 }]
      } else if (url.pathname.endsWith('/comments') || url.pathname.endsWith('/verdicts')) {
        body = []
      }
      return { ok: true, status: 200, json: async () => body }
    }),
  )
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }))
  // triggerDownload clicks a link, which jsdom would try to navigate.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(() => {
  // Unmount while the stubs still stand: the viewer's teardown uses them.
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

function renderScreen(showVersions: boolean) {
  return render(
    <ShareReviewScreen
      token="t" assetId="a1" assetName="Still.png" permission="view"
      allowDownload showVersions={showVersions}
    />,
  )
}

const optionsRequests = () => requests.filter((u) => u.pathname === '/share/t/downloads/a1')
const downloadRequests = () =>
  requests.filter((u) => u.pathname === '/share/t/stream/a1' && u.searchParams.get('download') === 'true')

async function downloadOriginal() {
  await userEvent.click(screen.getByRole('button', { name: 'Download' }))
  await userEvent.click(await screen.findByText('Original'))
  await waitFor(() => expect(downloadRequests()).toHaveLength(1))
}

describe('ShareReviewScreen download', () => {
  it('lists and downloads the version on screen, not the newest', async () => {
    renderScreen(true)
    await userEvent.click(await screen.findByRole('button', { name: 'Show v1' }, { timeout: 3000 }))

    await downloadOriginal()

    expect(optionsRequests().at(-1)?.searchParams.get('version_id')).toBe('v1')
    expect(downloadRequests()[0].searchParams.get('version_id')).toBe('v1')
    expect(downloadRequests()[0].searchParams.get('rendition')).toBe('original')
  })

  it('follows the switcher back to the newest', async () => {
    renderScreen(true)
    await userEvent.click(await screen.findByRole('button', { name: 'Show v1' }, { timeout: 3000 }))
    await userEvent.click(screen.getByRole('button', { name: 'Show v2' }))

    await downloadOriginal()

    expect(optionsRequests().at(-1)?.searchParams.get('version_id')).toBe('v2')
    expect(downloadRequests()[0].searchParams.get('version_id')).toBe('v2')
  })

  // A link that hides the history only ever shows its latest ready version,
  // which is what the server serves when no version is named.
  it('names no version on a link that does not show versions', async () => {
    renderScreen(false)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument(), { timeout: 3000 })

    await downloadOriginal()

    expect(optionsRequests().at(-1)?.searchParams.has('version_id')).toBe(false)
    expect(downloadRequests()[0].searchParams.has('version_id')).toBe(false)
  })
})
