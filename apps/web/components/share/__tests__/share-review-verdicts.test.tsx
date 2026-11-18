import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ShareReviewScreen } from '../share-review-screen'
import type { SharePermission } from '@/types'

// Where the client gives a verdict from a share link: the screen mounts the
// controls only on an `approve` link, and the first press asks who they are
// through the same name-and-email prompt comments use.

type Call = { method: string; url: URL; body: Record<string, unknown> | null }
let calls: Call[]
/** Read live by the matchMedia stub, so one file can be a desktop and a phone. */
let phone = false

beforeEach(() => {
  localStorage.clear()
  calls = []
  phone = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input)
      const method = init.method ?? 'GET'
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null })
      let body: unknown = {}
      if (url.pathname.endsWith('/stream/a1')) {
        body = { name: 'Poster.png', asset_type: 'image', version_id: 'v1', url: 'https://cdn.example/p.png' }
      } else if (url.pathname.endsWith('/assets/a1/versions')) {
        body = [{ id: 'v1', version_number: 1, processing_status: 'ready', created_at: '2026-11-18T10:00:00Z' }]
      } else if (url.pathname.endsWith('/comments') || url.pathname.endsWith('/verdicts')) {
        body = []
      }
      return { ok: true, status: 200, json: async () => body }
    }),
  )
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      // A portrait phone: no min-width query matches, and it is not landscape.
      return !phone
    },
    media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }))
})

afterEach(() => {
  // Unmount while the stubs still stand: the viewer's teardown uses them.
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

function renderScreen(permission: SharePermission) {
  return render(
    <ShareReviewScreen
      token="t" assetId="a1" assetName="Poster.png" permission={permission}
      allowDownload={false} showVersions={false}
    />,
  )
}

const puts = () => calls.filter((c) => c.method === 'PUT')
/** The screen is up once its comment tabs are. */
const loaded = () => waitFor(() => expect(screen.getByText('Fields')).toBeInTheDocument(), { timeout: 3000 })

describe('ShareReviewScreen verdicts', () => {
  it.each<SharePermission>(['view', 'comment'])('mounts no verdict controls on a %s link', async (permission) => {
    renderScreen(permission)
    await loaded()
    expect(screen.queryByRole('group', { name: 'Your verdict' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(calls.some((c) => c.url.pathname.endsWith('/verdicts'))).toBe(false)
  })

  it('mounts them on an approve link, in the top bar on a wide screen', async () => {
    renderScreen('approve')
    await loaded()
    const group = await screen.findByRole('group', { name: 'Your verdict' })
    expect(within(group).getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.queryByTestId('share-verdict-row')).toBeNull()
  })

  // Clients often approve from a phone, so the buttons get a row of their own
  // there rather than a place in a top bar that has no room left.
  it('gives them a row of their own on a phone', async () => {
    phone = true
    renderScreen('approve')
    await waitFor(() => expect(screen.getByTestId('share-verdict-row')).toBeInTheDocument(), { timeout: 3000 })
    const row = screen.getByTestId('share-verdict-row')
    expect(within(row).getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Changes needed' })).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Reject' })).toBeInTheDocument()
  })

  it('the first Approve opens the identity prompt; saving it stores the guest and sends the PUT', async () => {
    renderScreen('approve')
    await loaded()
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))

    const name = await screen.findByPlaceholderText('Your name')
    expect(puts()).toHaveLength(0)
    await userEvent.type(name, 'Dana')
    await userEvent.type(screen.getByPlaceholderText('Email address'), 'dana@client.example')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0].url.pathname).toBe('/share/t/verdict')
    expect(puts()[0].body).toEqual({
      version_id: 'v1',
      asset_id: 'a1',
      status: 'approved',
      guest_name: 'Dana',
      guest_email: 'dana@client.example',
    })
    expect(JSON.parse(localStorage.getItem('ff_guest_identity') ?? 'null')).toEqual({
      name: 'Dana',
      email: 'dana@client.example',
    })
    expect(screen.queryByPlaceholderText('Your name')).toBeNull()
  })

  it('cancelling the prompt sends nothing and stores nothing', async () => {
    renderScreen('approve')
    await loaded()
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))

    await screen.findByPlaceholderText('Your name')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByPlaceholderText('Your name')).toBeNull())
    expect(puts()).toHaveLength(0)
    expect(localStorage.getItem('ff_guest_identity')).toBeNull()

    // And a second try asks again rather than being stuck on the first promise.
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByPlaceholderText('Your name')).toBeInTheDocument()
  })

  it('does not ask a guest who already gave a name for a comment', async () => {
    localStorage.setItem('ff_guest_identity', JSON.stringify({ name: 'Dana', email: 'dana@client.example' }))
    renderScreen('approve')
    await loaded()
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(screen.queryByPlaceholderText('Your name')).toBeNull()
    expect(puts()[0].body).toMatchObject({ guest_email: 'dana@client.example' })
  })
})
