import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
import { ShareVerdictControls } from '../share-verdict-controls'
import type { Verdict } from '@/types'

const { signInAgain } = vi.hoisted(() => ({ signInAgain: vi.fn() }))
// The real refresh runs (through the fetch stub); only the navigation is caught.
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  signInAgain,
}))

function jwt(expSecondsFromNow: number): string {
  const b64url = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow
  return `${b64url({ alg: 'HS256' })}.${b64url({ sub: 'u1', exp })}.sig`
}

function makeVerdict(partial: Partial<Verdict> & { id: string }): Verdict {
  return {
    version_id: 'v1',
    status: 'approved',
    note: null,
    created_at: '2026-11-18T10:00:00Z',
    updated_at: '2026-11-18T10:00:00Z',
    who: { kind: 'external', name: 'Dana', avatar_url: null, avatar_color: null, is_guest: true },
    via_link_title: 'Client review',
    is_mine: false,
    ...partial,
  }
}

const dana = { name: 'Dana', email: 'dana@client.example' }

type Call = { method: string; url: URL; headers: Record<string, string>; body: Record<string, unknown> | null }
let calls: Call[]
let refreshes = 0
/** What the next write answers: a status and an optional JSON body. */
let writeAnswer: { status: number; body?: unknown }
/** What GET answers. */
let listed: Verdict[]
/** What POST /auth/refresh answers; `null` is no network. */
let refreshAnswer: { status: number; body?: unknown } | null

beforeEach(() => {
  localStorage.clear()
  calls = []
  refreshes = 0
  listed = []
  writeAnswer = { status: 200, body: {} }
  refreshAnswer = { status: 401, body: { detail: 'Invalid refresh token' } }
  signInAgain.mockClear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      if (input.endsWith('/auth/refresh')) {
        refreshes += 1
        if (!refreshAnswer) throw new TypeError('Failed to fetch')
        const answer = refreshAnswer
        return { ok: answer.status === 200, status: answer.status, json: async () => answer.body }
      }
      calls.push({
        method,
        url: new URL(input),
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      })
      const answer = method === 'GET' ? { status: 200, body: listed } : writeAnswer
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: async () => {
          if (answer.body === undefined) throw new SyntaxError('no body')
          return answer.body
        },
      }
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

type Props = React.ComponentProps<typeof ShareVerdictControls>

function ui(props: Partial<Props> = {}) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <ShareVerdictControls
        token="tok"
        assetId="a1"
        versionId="v1"
        shareSession={null}
        guestIdentity={null}
        requestIdentity={vi.fn(async () => null)}
        {...props}
      />
    </SWRConfig>
  )
}

const writes = () => calls.filter((c) => c.method !== 'GET')
const gets = () => calls.filter((c) => c.method === 'GET')
const button = (name: string) => screen.getByRole('button', { name })

describe('ShareVerdictControls', () => {
  it('shows the three buttons and the guest-scoped indicator, with no Remove', async () => {
    listed = [makeVerdict({ id: 'd1', note: 'Looks good' })]
    render(ui({ guestIdentity: dana }))

    expect(button('Approve')).toBeInTheDocument()
    expect(button('Changes needed')).toBeInTheDocument()
    expect(button('Reject')).toBeInTheDocument()

    const indicator = await screen.findByRole('button', { name: /1 verdict/ })
    await userEvent.click(indicator)
    expect(await screen.findByText('Looks good')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()

    // Read through this link, for this asset and version, as this guest.
    const get = gets()[0]
    expect(get.url.pathname).toBe('/share/tok/verdicts')
    expect(get.url.searchParams.get('asset_id')).toBe('a1')
    expect(get.url.searchParams.get('version_id')).toBe('v1')
    expect(get.url.searchParams.get('guest_email')).toBe('dana@client.example')
  })

  it('the first Approve with no identity opens the prompt, then sends the PUT with what was saved', async () => {
    const requestIdentity = vi.fn(async () => dana)
    render(ui({ requestIdentity }))

    await userEvent.click(button('Approve'))

    expect(requestIdentity).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(writes()).toHaveLength(1))
    const put = writes()[0]
    expect(put.method).toBe('PUT')
    expect(put.url.pathname).toBe('/share/tok/verdict')
    expect(put.headers.Authorization).toBeUndefined()
    expect(put.body).toEqual({
      version_id: 'v1',
      asset_id: 'a1',
      status: 'approved',
      guest_name: 'Dana',
      guest_email: 'dana@client.example',
    })
  })

  it('a cancelled prompt sends nothing', async () => {
    const requestIdentity = vi.fn(async () => null)
    render(ui({ requestIdentity }))

    await userEvent.click(button('Approve'))
    await userEvent.click(button('Reject'))

    expect(requestIdentity).toHaveBeenCalledTimes(2)
    expect(writes()).toHaveLength(0)
    // A cancelled Reject does not open its note box either.
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('does not prompt a guest who already has an identity', async () => {
    const requestIdentity = vi.fn(async () => null)
    render(ui({ guestIdentity: dana, requestIdentity }))

    await userEvent.click(button('Approve'))

    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(requestIdentity).not.toHaveBeenCalled()
    expect(writes()[0].body).toMatchObject({ guest_email: 'dana@client.example', guest_name: 'Dana' })
  })

  it('does not prompt someone signed in with a good token, and files the verdict under them', async () => {
    const token = jwt(3600)
    localStorage.setItem('ff_access_token', token)
    const requestIdentity = vi.fn(async () => null)
    render(ui({ guestIdentity: dana, requestIdentity }))

    await userEvent.click(button('Approve'))

    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(requestIdentity).not.toHaveBeenCalled()
    expect(writes()[0].headers.Authorization).toBe(`Bearer ${token}`)
    expect(writes()[0].body).not.toHaveProperty('guest_email')
  })

  // Ruling R15: a lapsed sign-in is refreshed or asked about, never quietly
  // turned into a guest. Someone signed in is never asked for a guest name.
  describe('a lapsed sign-in', () => {
    beforeEach(() => {
      localStorage.setItem('ff_access_token', jwt(-60))
      localStorage.setItem('ff_refresh_token', 'the-refresh-token')
    })

    it('is refreshed, and the verdict goes under the new bearer with no guest fields', async () => {
      const fresh = jwt(3600)
      refreshAnswer = { status: 200, body: { access_token: fresh, refresh_token: 'rotated' } }
      const requestIdentity = vi.fn(async () => null)
      render(ui({ guestIdentity: dana, requestIdentity }))

      await userEvent.click(button('Approve'))

      await waitFor(() => expect(writes()).toHaveLength(1))
      expect(refreshes).toBe(1)
      expect(requestIdentity).not.toHaveBeenCalled()
      expect(writes()[0].headers.Authorization).toBe(`Bearer ${fresh}`)
      expect(writes()[0].body).not.toHaveProperty('guest_email')
      expect(writes()[0].body).not.toHaveProperty('guest_name')
    })

    it.each([
      ['refused', { status: 401, body: { detail: 'Invalid refresh token' } }],
      ['offline', null],
    ])('that will not refresh (%s) sends nothing and says so, with a stored guest', async (_, answer) => {
      refreshAnswer = answer
      const requestIdentity = vi.fn(async () => null)
      render(ui({ guestIdentity: dana, requestIdentity }))

      await userEvent.click(button('Approve'))

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Your sign-in has expired. Sign in again or continue as a guest.',
      )
      expect(writes()).toHaveLength(0)
      expect(requestIdentity).not.toHaveBeenCalled()
      expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
        'href',
        `/login?from=${encodeURIComponent(window.location.pathname + window.location.search)}`,
      )
    })

    it('"Continue as guest" then sends the stored guest with no Authorization', async () => {
      render(ui({ guestIdentity: dana }))
      await userEvent.click(button('Approve'))
      await screen.findByRole('alert')

      await userEvent.click(button('Continue as guest'))

      await waitFor(() => expect(writes()).toHaveLength(1))
      expect(writes()[0].headers.Authorization).toBeUndefined()
      expect(writes()[0].body).toEqual({
        version_id: 'v1',
        asset_id: 'a1',
        status: 'approved',
        guest_name: 'Dana',
        guest_email: 'dana@client.example',
      })
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

      // The choice holds for the next press: no second refresh, no second question.
      const before = refreshes
      await userEvent.click(button('Reject'))
      await userEvent.click(await screen.findByRole('button', { name: 'Send' }))
      await waitFor(() => expect(writes()).toHaveLength(2))
      expect(refreshes).toBe(before)
      expect(writes()[1].body).toMatchObject({ status: 'rejected', guest_email: 'dana@client.example' })
    })

    it('"Continue as guest" with no guest identity asks for one first', async () => {
      const requestIdentity = vi.fn(async () => dana)
      render(ui({ requestIdentity }))
      await userEvent.click(button('Approve'))
      expect(requestIdentity).not.toHaveBeenCalled()
      await screen.findByRole('alert')

      await userEvent.click(button('Continue as guest'))

      expect(requestIdentity).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(writes()).toHaveLength(1))
      expect(writes()[0].headers.Authorization).toBeUndefined()
      expect(writes()[0].body).toMatchObject({ guest_name: 'Dana', guest_email: 'dana@client.example' })
    })

    it('"Continue as guest" whose prompt is cancelled sends nothing', async () => {
      const requestIdentity = vi.fn(async () => null)
      render(ui({ requestIdentity }))
      await userEvent.click(button('Approve'))
      await screen.findByRole('alert')

      await userEvent.click(button('Continue as guest'))

      expect(requestIdentity).toHaveBeenCalledTimes(1)
      expect(writes()).toHaveLength(0)
    })

    it('"Sign in" ends the dead session and goes to /login with this page to come back to', async () => {
      render(ui({ guestIdentity: dana }))
      await userEvent.click(button('Approve'))
      await screen.findByRole('alert')

      await userEvent.click(screen.getByRole('link', { name: 'Sign in' }))

      expect(signInAgain).toHaveBeenCalledWith(window.location.pathname + window.location.search)
      expect(writes()).toHaveLength(0)
    })
  })

  // A bearer the server could not resolve (revoked, say) gets the same choice.
  it('offers the same choice when the server answers the stale sign-in 401', async () => {
    localStorage.setItem('ff_access_token', jwt(3600))
    writeAnswer = {
      status: 401,
      body: { detail: 'Your sign-in has expired. Sign in again or continue as a guest.' },
    }
    render(ui({ guestIdentity: dana }))

    await userEvent.click(button('Approve'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Your sign-in has expired.')
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument()
    expect(button('Continue as guest')).toBeInTheDocument()
  })

  it('offers no sign-in actions for any other failure', async () => {
    writeAnswer = { status: 403, body: { detail: 'This share link does not allow approvals' } }
    render(ui({ guestIdentity: dana }))
    await userEvent.click(button('Approve'))
    await screen.findByRole('alert')
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue as guest' })).toBeNull()
  })

  it('Changes needed asks for identity before its note box opens, and sends the note', async () => {
    const requestIdentity = vi.fn(async () => dana)
    render(ui({ requestIdentity }))

    await userEvent.click(button('Changes needed'))
    expect(requestIdentity).toHaveBeenCalledTimes(1)
    const note = await screen.findByRole('textbox')
    expect(writes()).toHaveLength(0)

    await userEvent.type(note, 'Logo is too small')
    await userEvent.click(button('Send'))

    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].body).toMatchObject({
      status: 'changes_requested',
      note: 'Logo is too small',
      guest_email: 'dana@client.example',
    })
  })

  it('shows my verdict as pressed, and pressing it again clears it as this guest', async () => {
    listed = [makeVerdict({ id: 'm1', status: 'approved', is_mine: true })]
    writeAnswer = { status: 204 }
    render(ui({ guestIdentity: dana }))

    await waitFor(() => expect(button('Approve')).toHaveAttribute('aria-pressed', 'true'))
    await userEvent.click(button('Approve'))

    await waitFor(() => expect(writes()).toHaveLength(1))
    const del = writes()[0]
    expect(del.method).toBe('DELETE')
    expect(del.url.pathname).toBe('/share/tok/verdict')
    expect(del.url.searchParams.get('version_id')).toBe('v1')
    expect(del.url.searchParams.get('asset_id')).toBe('a1')
    expect(del.url.searchParams.get('guest_email')).toBe('dana@client.example')
  })

  it('revalidates the list after a successful write', async () => {
    render(ui({ guestIdentity: dana }))
    await waitFor(() => expect(gets()).toHaveLength(1))

    listed = [makeVerdict({ id: 'm1', status: 'approved', is_mine: true })]
    await userEvent.click(button('Approve'))

    await waitFor(() => expect(button('Approve')).toHaveAttribute('aria-pressed', 'true'))
    expect(gets().length).toBeGreaterThanOrEqual(2)
  })

  it('shows a 403 detail inline', async () => {
    writeAnswer = { status: 403, body: { detail: "Your project role can't give verdicts" } }
    render(ui({ guestIdentity: dana }))

    await userEvent.click(button('Approve'))

    expect(await screen.findByRole('alert')).toHaveTextContent("Your project role can't give verdicts")
  })

  it('shows the stale sign-in 401 detail inline', async () => {
    writeAnswer = {
      status: 401,
      body: { detail: 'Your sign-in has expired. Sign in again or continue as a guest.' },
    }
    render(ui({ guestIdentity: dana }))

    await userEvent.click(button('Approve'))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your sign-in has expired. Sign in again or continue as a guest.',
    )
  })

  it('refetches for the new version on a version switch', async () => {
    const { rerender } = render(ui({ guestIdentity: dana }))
    await waitFor(() => expect(gets()).toHaveLength(1))

    rerender(ui({ guestIdentity: dana, versionId: 'v2' }))

    await waitFor(() => expect(gets().some((c) => c.url.searchParams.get('version_id') === 'v2')).toBe(true))
  })

  it('passes the share session on every call', async () => {
    render(ui({ guestIdentity: dana, shareSession: 'sess-1' }))
    await waitFor(() => expect(gets()).toHaveLength(1))
    await userEvent.click(button('Approve'))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(gets()[0].url.searchParams.get('share_session')).toBe('sess-1')
    expect(writes()[0].url.searchParams.get('share_session')).toBe('sess-1')
  })
})
