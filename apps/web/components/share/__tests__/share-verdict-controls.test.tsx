import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
import { ShareVerdictControls } from '../share-verdict-controls'
import { resetShareRequestState } from '@/lib/share-request'
import type { Verdict } from '@/types'

const { signInAgain } = vi.hoisted(() => ({ signInAgain: vi.fn() }))
// The real refresh runs (through the fetch stub); only the navigation is caught.
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  signInAgain,
}))

function jwt(expSecondsFromNow: number, sub = 'u1'): string {
  const b64url = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow
  return `${b64url({ alg: 'HS256' })}.${b64url({ sub, exp })}.sig`
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
/** Answers used, in order, before `refreshAnswer` / `writeAnswer`. */
let refreshQueue: Array<{ status: number; body?: unknown } | null>
let writeQueue: Array<{ status: number; body?: unknown }>
/** When set, GET answers by who asked, as the server scopes it. */
let listedFor: ((call: Call) => Verdict[]) | null
/** When it says so, a GET gets no answer (the network drops it). */
let getFails: ((call: Call) => boolean) | null

beforeEach(() => {
  localStorage.clear()
  calls = []
  refreshes = 0
  listed = []
  refreshQueue = []
  writeQueue = []
  listedFor = null
  getFails = null
  resetShareRequestState()
  writeAnswer = { status: 200, body: {} }
  refreshAnswer = { status: 401, body: { detail: 'Invalid refresh token' } }
  signInAgain.mockClear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      if (input.endsWith('/auth/refresh')) {
        refreshes += 1
        const answer = refreshQueue.length ? refreshQueue.shift() : refreshAnswer
        if (!answer) throw new TypeError('Failed to fetch')
        return { ok: answer.status === 200, status: answer.status, json: async () => answer.body }
      }
      const call: Call = {
        method,
        url: new URL(input),
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      }
      calls.push(call)
      if (method === 'GET' && getFails?.(call)) throw new TypeError('Failed to fetch')
      const answer =
        method === 'GET'
          ? { status: 200, body: listedFor ? listedFor(call) : listed }
          : writeQueue.length
            ? writeQueue.shift()!
            : writeAnswer
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

  // A lapsed sign-in is refreshed or asked about, never quietly
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

    it('that is refused sends nothing and says so, with a stored guest', async () => {
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

    // A refresh that got no answer is a "try again", not a "sign in again".
    it('whose refresh gets no answer says to try again, with no sign-in choice and the tokens untouched', async () => {
      const stale = localStorage.getItem('ff_access_token')
      refreshAnswer = null
      render(ui({ guestIdentity: dana }))

      await userEvent.click(button('Approve'))

      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach the server. Try again.")
      expect(writes()).toHaveLength(0)
      expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Continue as guest' })).toBeNull()
      expect(localStorage.getItem('ff_access_token')).toBe(stale)
      expect(localStorage.getItem('ff_refresh_token')).toBe('the-refresh-token')
    })

    // The stored guest's verdict must not show as this
    // signed-in person's, or pressing it would clear their own instead.
    it('that will not refresh reads as nobody: no bearer, no guest email, nothing pressed', async () => {
      const guestsApproval = makeVerdict({ id: 'g1', status: 'approved', is_mine: true })
      listedFor = (call) => (call.url.searchParams.get('guest_email') ? [guestsApproval] : [])
      render(ui({ guestIdentity: dana }))

      await waitFor(() => expect(gets()).toHaveLength(1))
      const get = gets()[0]
      expect(get.headers.Authorization).toBeUndefined()
      expect(get.url.searchParams.has('guest_email')).toBe(false)
      expect(button('Approve')).toHaveAttribute('aria-pressed', 'false')
    })

    it('refreshed at the press decides clear-or-give against their own verdict, not the list read before', async () => {
      // The page's read got no answer from /auth/refresh, so it read as nobody;
      // the press's refresh works, and they had already approved.
      refreshQueue = [null]
      const fresh = jwt(3600)
      refreshAnswer = { status: 200, body: { access_token: fresh, refresh_token: 'rotated' } }
      const theirApproval = makeVerdict({ id: 'u1', status: 'approved', is_mine: true })
      const guestsRejection = makeVerdict({ id: 'g1', status: 'rejected', is_mine: true })
      listedFor = (call) =>
        call.headers.Authorization ? [theirApproval] : call.url.searchParams.get('guest_email') ? [guestsRejection] : []
      writeAnswer = { status: 204 }
      render(ui({ guestIdentity: dana }))
      await waitFor(() => expect(gets()).toHaveLength(1))
      expect(button('Approve')).toHaveAttribute('aria-pressed', 'false')

      await userEvent.click(button('Approve'))

      // Approve was theirs already, so pressing it is the undo, as them.
      await waitFor(() => expect(writes()).toHaveLength(1))
      expect(writes()[0].method).toBe('DELETE')
      expect(writes()[0].headers.Authorization).toBe(`Bearer ${fresh}`)
      expect(writes()[0].url.searchParams.has('guest_email')).toBe(false)
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

  // A bearer the server could not resolve (revoked, say) gets the same choice,
  // once a refresh and a retry have not fixed it.
  describe('a bearer the server refuses', () => {
    beforeEach(() => {
      localStorage.setItem('ff_access_token', jwt(3600))
      localStorage.setItem('ff_refresh_token', 'the-refresh-token')
      writeQueue = [{ status: 401, body: { detail: 'Your sign-in has expired. Sign in again or continue as a guest.' } }]
    })

    // Regression: this used to send the same bearer again, forever.
    it('"Continue as guest" then really goes as the guest: guest fields, no Authorization', async () => {
      refreshAnswer = { status: 403, body: { detail: 'User is deactivated' } }
      render(ui({ guestIdentity: dana }))

      await userEvent.click(button('Approve'))
      expect(await screen.findByRole('alert')).toHaveTextContent('Your sign-in has expired.')
      expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument()

      await userEvent.click(button('Continue as guest'))

      await waitFor(() => expect(writes()).toHaveLength(2))
      expect(writes()[1].headers.Authorization).toBeUndefined()
      expect(writes()[1].body).toMatchObject({ guest_name: 'Dana', guest_email: 'dana@client.example' })
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    })

    // The press was decided against their own list
    // (Approve was theirs, so it was a clear). As the guest it is decided
    // again, against the guest's list, rather than re-sending that clear.
    it('"Continue as guest" re-reads as the guest and decides the press again', async () => {
      refreshAnswer = { status: 401, body: {} }
      const theirApproval = makeVerdict({ id: 'u1', status: 'approved', is_mine: true })
      listedFor = (call) => (call.headers.Authorization ? [theirApproval] : [])
      render(ui({ guestIdentity: dana }))
      await waitFor(() => expect(button('Approve')).toHaveAttribute('aria-pressed', 'true'))

      await userEvent.click(button('Approve'))
      await screen.findByRole('alert')
      expect(writes()[0].method).toBe('DELETE')
      expect(writes()[0].headers.Authorization).toBeDefined()

      const getsBefore = gets().length
      await userEvent.click(button('Continue as guest'))

      await waitFor(() => expect(writes()).toHaveLength(2))
      // Read again as the guest, before deciding.
      const guestRead = gets().slice(getsBefore).find((c) => c.url.searchParams.get('guest_email'))
      expect(guestRead).toBeDefined()
      // The guest had no verdict, so pressing Approve gives one; it does not clear.
      expect(writes()[1].method).toBe('PUT')
      expect(writes()[1].headers.Authorization).toBeUndefined()
      expect(writes()[1].body).toMatchObject({ status: 'approved', guest_email: 'dana@client.example' })
    })

    // Through the controls: the guest's list could not be read, so there is
    // nothing to decide against. The press stops; it is not decided against
    // the signed-in list still on screen.
    it('"Continue as guest" whose re-read as the guest fails sends nothing and says to try again', async () => {
      refreshAnswer = { status: 401, body: {} }
      const theirApproval = makeVerdict({ id: 'u1', status: 'approved', is_mine: true })
      listedFor = (call) => (call.headers.Authorization ? [theirApproval] : [])
      render(ui({ guestIdentity: dana }))
      await waitFor(() => expect(button('Approve')).toHaveAttribute('aria-pressed', 'true'))
      await userEvent.click(button('Approve'))
      await screen.findByRole('alert')
      expect(writes()).toHaveLength(1)

      getFails = (call) => !!call.url.searchParams.get('guest_email')
      await userEvent.click(button('Continue as guest'))

      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach the server. Try again.")
      expect(gets().some((c) => c.url.searchParams.get('guest_email'))).toBe(true)
      expect(writes()).toHaveLength(1)
    })

    it('after the choice, a new token that lapses is refreshed and the press goes as them', async () => {
      refreshAnswer = { status: 401, body: {} }
      render(ui({ guestIdentity: dana }))
      await userEvent.click(button('Approve'))
      await screen.findByRole('alert')
      await userEvent.click(button('Continue as guest'))
      await waitFor(() => expect(writes()).toHaveLength(2))
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

      // Signed in again in another tab, and that token has lapsed too.
      localStorage.setItem('ff_access_token', jwt(-60))
      localStorage.setItem('ff_refresh_token', 'another-refresh-token')
      // Not the refused token's twin: jwt() of the same expiry in the same second is.
      const fresh = jwt(7200)
      refreshAnswer = { status: 200, body: { access_token: fresh, refresh_token: 'rotated' } }

      await userEvent.click(button('Reject'))
      await userEvent.click(await screen.findByRole('button', { name: 'Send' }))

      await waitFor(() => expect(writes()).toHaveLength(3))
      expect(writes()[2].headers.Authorization).toBe(`Bearer ${fresh}`)
      expect(writes()[2].body).not.toHaveProperty('guest_email')
    })

    it('is refreshed and retried once, and the verdict lands under the new bearer', async () => {
      const fresh = jwt(7200)
      refreshAnswer = { status: 200, body: { access_token: fresh, refresh_token: 'rotated' } }
      render(ui({ guestIdentity: dana }))

      await userEvent.click(button('Approve'))

      await waitFor(() => expect(writes()).toHaveLength(2))
      expect(writes()[1].headers.Authorization).toBe(`Bearer ${fresh}`)
      expect(writes()[1].body).not.toHaveProperty('guest_email')
      expect(screen.queryByRole('alert')).toBeNull()
    })
  })

  it('offers no sign-in actions for any other failure', async () => {
    writeAnswer = { status: 403, body: { detail: 'This share link does not allow approvals' } }
    render(ui({ guestIdentity: dana }))
    await userEvent.click(button('Approve'))
    await screen.findByRole('alert')
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue as guest' })).toBeNull()
  })

  // The list on screen was read as one caller, and
  // another is pressing now (here, signed in in another tab). The press is
  // decided against the presser's own list, read again as them.
  it('re-reads as whoever is pressing now when that is not who the list was read as', async () => {
    const theirApproval = makeVerdict({ id: 'u1', status: 'approved', is_mine: true })
    listedFor = (call) => (call.headers.Authorization ? [theirApproval] : [])
    writeAnswer = { status: 204 }
    render(ui({ guestIdentity: dana }))
    await waitFor(() => expect(gets()).toHaveLength(1))
    expect(gets()[0].url.searchParams.get('guest_email')).toBe('dana@client.example')
    expect(button('Approve')).toHaveAttribute('aria-pressed', 'false')

    const token = jwt(3600)
    localStorage.setItem('ff_access_token', token)
    await userEvent.click(button('Approve'))

    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(gets().some((c) => c.headers.Authorization === `Bearer ${token}`)).toBe(true)
    // Their own Approve was already given, so the press is the undo, as them.
    expect(writes()[0].method).toBe('DELETE')
    expect(writes()[0].headers.Authorization).toBe(`Bearer ${token}`)
  })

  // The other way round: read as the guest, signed in
  // elsewhere, and their own list cannot be read. Nothing is sent.
  it('a re-read as a newly signed-in person that fails sends nothing and says to try again', async () => {
    const theirApproval = makeVerdict({ id: 'u1', status: 'approved', is_mine: true })
    listedFor = (call) => (call.headers.Authorization ? [theirApproval] : [])
    render(ui({ guestIdentity: dana }))
    await waitFor(() => expect(gets()).toHaveLength(1))

    localStorage.setItem('ff_access_token', jwt(3600))
    getFails = (call) => !!call.headers.Authorization
    await userEvent.click(button('Approve'))

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach the server. Try again.")
    expect(writes()).toHaveLength(0)
  })

  // Another account signed in in another tab. Its press
  // is decided against its own list, read again as it, not the first one's.
  it('re-reads as the account now signed in when it is not the one the list was read as', async () => {
    const alice = jwt(3600, 'alice')
    const bob = jwt(3600, 'bob')
    localStorage.setItem('ff_access_token', alice)
    const alicesApproval = makeVerdict({ id: 'a1', status: 'approved', is_mine: true })
    listedFor = (call) => (call.headers.Authorization === `Bearer ${alice}` ? [alicesApproval] : [])
    render(ui({ guestIdentity: null }))
    await waitFor(() => expect(button('Approve')).toHaveAttribute('aria-pressed', 'true'))

    localStorage.setItem('ff_access_token', bob)
    await userEvent.click(button('Approve'))

    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(gets().some((c) => c.headers.Authorization === `Bearer ${bob}`)).toBe(true)
    // Bob has no verdict, so Approve gives one as Bob; it does not clear Alice's.
    expect(writes()[0].method).toBe('PUT')
    expect(writes()[0].headers.Authorization).toBe(`Bearer ${bob}`)
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
