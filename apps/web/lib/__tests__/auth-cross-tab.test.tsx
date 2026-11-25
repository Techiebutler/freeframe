// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://localhost:3000/frame/projects?view=mine" }
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { row } from '@/test/upload-session'

vi.mock('@/components/review/image-viewer', () => ({ ImageViewer: () => null }))

const noticeKey = 'ff_session_notice'
const guest = { name: 'Guest', email: 'guest@example.test' }
const tokenFor = (sub: string) => `e30.${btoa(JSON.stringify({ sub, exp: 4102444800 }))}.sig`
const alice = tokenFor('alice')
const bob = tokenFor('bob')
const restored = (token: string) => Response.json({ access_token: token })
const refused = () => new Response(null, { status: 401 })
const unavailable = () => new Response(null, { status: 503 })
const tab = window

function otherTab(account: string | null) {
  const oldValue = localStorage.getItem(noticeKey)
  const newValue = JSON.stringify({ account, nonce: 'other-tab' })
  localStorage.setItem(noticeKey, newValue)
  tab.dispatchEvent(new StorageEvent('storage', { key: noticeKey, oldValue, newValue }))
}

function installCookieLocks() {
  const queues = new Map<string, Promise<unknown>>()
  const released = vi.fn()
  const request = vi.fn((name: string, run: () => Promise<unknown>) => {
    const previous = queues.get(name) ?? Promise.resolve()
    const next = previous.then(async () => {
      try {
        return await run()
      } finally {
        released(name)
      }
    })
    queues.set(name, next.catch(() => {}))
    return next
  })
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
  return { request, released }
}

function observeNavigation() {
  const { origin, protocol, pathname, search } = tab.location
  const location = { origin, protocol, pathname, search, href: '', replace: vi.fn() }
  vi.stubGlobal('window', { location, document, get event() { return tab.event } })
  return location
}

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
  localStorage.clear()
  vi.spyOn(tab, 'addEventListener')
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
  for (const [key, listener] of vi.mocked(tab.addEventListener).mock.calls) {
    if (key === 'storage') tab.removeEventListener(key, listener)
  }
  Reflect.deleteProperty(navigator, 'locks')
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('publishes the account, not a credential, and publishes no account on explicit sign-out', async () => {
  const auth = await import('../auth')
  auth.setTokens(alice)
  const notice = localStorage.getItem(noticeKey)!
  expect(JSON.parse(notice)).toMatchObject({ account: 'alice' })
  expect(notice).not.toContain(alice)
  expect(localStorage.getItem('ff_signed_in_hint')).toBe('1')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
  const location = observeNavigation()
  await expect(auth.clearTokens()).resolves.toBe(true)
  expect(JSON.parse(localStorage.getItem(noticeKey)!)).toMatchObject({ account: null })
  expect(localStorage.getItem('ff_signed_in_hint')).toBeNull()
  expect(location.href).toBe('/login')
})

it('keeps the current upload owner and leave guard on same-account notices, but clears on a switch', async () => {
  const auth = await import('../auth')
  const { watchSubject } = await import('../upload-owner')
  auth.setTokens(alice)
  const { useUploadStore } = await import('@/stores/upload-store')
  const queued = row({ status: 'queued', ownerId: 'alice' })
  useUploadStore.setState({ files: [queued], subject: 'alice' })
  const changed = vi.fn()
  const ended = vi.fn()
  watchSubject(changed)
  auth.onSessionEnded(ended)
  otherTab('alice')
  expect(auth.getAccessToken()).toBe(alice)
  expect(auth.isLeaveGuardSuppressed()).toBe(false)
  expect(changed).not.toHaveBeenCalled()
  expect(ended).not.toHaveBeenCalled()
  expect(useUploadStore.getState().files[0]).toMatchObject({ status: 'queued', ownerId: 'alice' })
  otherTab('bob')
  expect(ended).toHaveBeenCalledOnce()
  expect(useUploadStore.getState().files[0]).toMatchObject({ status: 'failed', ownerId: 'alice' })
  expect(auth.getAccessToken()).toBeNull()
  expect(auth.isLeaveGuardSuppressed()).toBe(true)
})

it('keeps a pending refresh valid on a same-account notice', async () => {
  const auth = await import('../auth')
  auth.setTokens(alice)
  let respond!: (response: Response) => void
  const fetch = vi.fn(() => new Promise<Response>(resolve => { respond = resolve }))
  vi.stubGlobal('fetch', fetch)
  const pending = auth.refreshAccessTokenQuietly()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  otherTab('alice')
  const renewed = alice.replace(/sig$/, 'renewed')
  respond(restored(renewed))
  await expect(pending).resolves.toEqual({ token: renewed })
  expect(auth.getAccessToken()).toBe(renewed)
})

it('starts a new bootstrap rather than sharing a refresh invalidated by a notice', async () => {
  const auth = await import('../auth')
  auth.setTokens(alice)
  let respond!: (response: Response) => void
  const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { respond = resolve }))
    .mockResolvedValueOnce(restored(bob))
  vi.stubGlobal('fetch', fetch)
  const pending = auth.refreshAccessTokenQuietly()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  otherTab('bob')
  const newSession = auth.bootstrapSession()
  respond(restored(alice))
  await expect(pending).resolves.toEqual({ failed: 'refused' })
  await expect(newSession).resolves.toEqual({ token: bob })
  expect(auth.getAccessToken()).toBe(bob)
})

it('goes to login if a refresh is refused after another tab signs out', async () => {
  const auth = await import('../auth')
  auth.setTokens(alice)
  otherTab(null)
  expect(auth.getAccessToken()).toBeNull()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(refused()))
  const location = observeNavigation()
  await expect(auth.refreshAccessToken()).resolves.toBeNull()
  expect(location.href).toBe('/login')
})

it('uses the origin-wide lock for cookie mutations', async () => {
  const request = vi.fn(async (_name: string, run: () => unknown) => run())
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
  const auth = await import('../auth')
  const fetch = vi.fn().mockResolvedValue(restored(alice))
  vi.stubGlobal('fetch', fetch)
  await expect(auth.bootstrapSession()).resolves.toEqual({ token: alice })
  expect(request).toHaveBeenCalledExactlyOnceWith('ff-auth-cookie', expect.any(Function))
  expect(request.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[0])
  expect(localStorage.getItem('ff_signed_in_hint')).toBe('1')
})

it.each([
  { method: 'POST', path: '/auth/login' },
  { method: 'POST', path: '/auth/verify-magic-code' },
  { method: 'POST', path: '/auth/accept-invite' },
  { method: 'PATCH', path: '/auth/change-password' },
  { method: 'POST', path: '/setup/create-superadmin' },
  { method: 'POST', path: '/auth/logout' },
])('holds the cookie lock through the $method $path response', async ({ method, path }) => {
  const { request, released } = installCookieLocks()
  const { api } = await import('../api')
  const auth = await import('../auth')
  const location = observeNavigation()
  const isLogout = path === '/auth/logout'
  let respond!: (response: Response) => void
  const fetch = vi.fn(() => new Promise<Response>(resolve => { respond = resolve }))
  vi.stubGlobal('fetch', fetch)

  const pending = isLogout ? auth.clearTokens() : (method === 'PATCH' ? api.patch : api.post)(path, {})
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api${path}`, expect.objectContaining({ method })))
  const responseArrived = vi.fn(respond)
  responseArrived(isLogout ? new Response(null, { status: 204 }) : restored(alice))
  expect(await pending).toEqual(isLogout ? true : { access_token: alice })

  expect(request).toHaveBeenCalledExactlyOnceWith('ff-auth-cookie', expect.any(Function))
  expect(request.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[0])
  expect(released).toHaveBeenCalledExactlyOnceWith('ff-auth-cookie')
  expect(released.mock.invocationCallOrder[0]).toBeGreaterThan(responseArrived.mock.invocationCallOrder[0])
  if (isLogout) expect(location.href).toBe('/login')
})

it('queues login in another tab until an in-flight refresh refusal is handled', async () => {
  const { request } = installCookieLocks()
  const tabA = await import('../auth')
  vi.resetModules()
  const tabB = await import('../auth')
  const { api } = await import('../api')
  expect(tabA).not.toBe(tabB)

  // Clearing legacy storage is part of handling a refused refresh.
  const removeItem = vi.spyOn(Storage.prototype, 'removeItem')
  let respond!: (response: Response) => void
  const loginStarted = vi.fn()
  const fetch = vi.fn((url: string) => {
    if (url === '/api/auth/refresh') return new Promise<Response>(resolve => { respond = resolve })
    loginStarted(removeItem.mock.calls.some(([key]) => key === 'ff_refresh_token'))
    return Promise.resolve(restored(bob))
  })
  vi.stubGlobal('fetch', fetch)

  const refresh = tabA.refreshAccessTokenQuietly()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/refresh', expect.anything()))
  const login = api.post('/auth/login', { email: 'bob@example.test', password: 'fixture' })
  await Promise.resolve()
  const fetchesBeforeRefusal = fetch.mock.calls.map(([url]) => url)

  respond(refused())
  await expect(refresh).resolves.toEqual({ failed: 'refused' })
  await expect(login).resolves.toEqual({ access_token: bob })
  expect(fetchesBeforeRefusal).toEqual(['/api/auth/refresh'])
  expect(request).toHaveBeenNthCalledWith(2, 'ff-auth-cookie', expect.any(Function))
  expect(fetch).toHaveBeenNthCalledWith(2, '/api/auth/login', expect.objectContaining({ method: 'POST' }))
  expect(loginStarted).toHaveBeenCalledExactlyOnceWith(true)
})

it('waits for the new account before posting a share comment after another tab signs back in', async () => {
  const auth = await import('../auth')
  const { shareRequest } = await import('../share-request')
  auth.setTokens(alice)
  otherTab(null)
  otherTab('bob')
  const fetch = vi.fn().mockResolvedValueOnce(restored(bob)).mockResolvedValueOnce(Response.json({ id: 'c1' }))
  vi.stubGlobal('fetch', fetch)
  await expect(shareRequest('link', '/comment', { method: 'POST', body: { body: 'Note' }, guest })).resolves.toEqual({ id: 'c1' })
  expect(fetch.mock.calls[0][0]).toBe('/api/auth/refresh')
  expect(fetch.mock.calls[1][1]).toMatchObject({ headers: { Authorization: `Bearer ${bob}` }, body: '{"body":"Note"}' })
})

it('fails a share write on transient bootstrap, then restores instead of remembering the failure', async () => {
  const auth = await import('../auth')
  const { shareRequest, SERVER_UNREACHABLE } = await import('../share-request')
  const fetch = vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(restored(alice))
    .mockResolvedValueOnce(Response.json({ id: 'c1' }))
  vi.stubGlobal('fetch', fetch)
  const write = () => shareRequest('link', '/comment', { method: 'POST', body: { body: 'Note' }, guest })
  await expect(auth.bootstrapSession()).resolves.toEqual({ failed: 'transient' })
  await expect(write()).rejects.toThrow(SERVER_UNREACHABLE)
  expect(fetch).toHaveBeenCalledTimes(1)
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 6000)
  await expect(write()).resolves.toEqual({ id: 'c1' })
  expect(fetch.mock.calls[2][1].headers).toMatchObject({ Authorization: `Bearer ${alice}` })
})

it('requires an explicit guest choice after a reload with a dead cookie and a saved guest', async () => {
  localStorage.setItem('ff_signed_in_hint', '1')
  localStorage.setItem('ff_guest_identity', JSON.stringify(guest))
  const { shareRequest, readGuestIdentity, continueAsGuest, SIGN_IN_EXPIRED } = await import('../share-request')
  const fetch = vi.fn().mockResolvedValueOnce(refused()).mockResolvedValueOnce(Response.json({ id: 'c1' }))
  vi.stubGlobal('fetch', fetch)
  const write = () => shareRequest('link', '/comment', { method: 'POST', body: { body: 'Note' }, guest: readGuestIdentity() })
  const failure = await write().catch(err => err)
  expect(failure).toMatchObject({ message: SIGN_IN_EXPIRED, status: 401 })
  expect(fetch).toHaveBeenCalledTimes(1)
  continueAsGuest(failure)
  await expect(write()).resolves.toEqual({ id: 'c1' })
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ guest_email: guest.email })
})

it.each([200, 401])('settles the cookie caller before the share composer posts a comment (refresh %i)', async (status) => {
  if (status === 401) {
    localStorage.setItem('ff_signed_in_hint', '1')
    localStorage.setItem('ff_guest_identity', JSON.stringify(guest))
  }
  const writes = vi.fn()
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    switch (new URL(url, tab.location.origin).pathname) {
      case '/api/auth/refresh': return status === 200 ? restored(alice) : refused()
      case '/api/share/link/stream/a1':
        return Response.json({ name: 'Still', asset_type: 'image', version_id: 'v1' })
      case '/api/share/link/assets/a1/versions':
        return Response.json([{ id: 'v1', version_number: 1, processing_status: 'ready', created_at: '' }])
      case '/api/share/link/comments': return Response.json([])
      case '/api/share/link/comment': {
        const body = JSON.parse(String(init?.body))
        writes(new Headers(init?.headers).get('Authorization'), body)
        return Response.json({ id: 'c1', body: body.body })
      }
      default: return new Response(null, { status: 404 })
    }
  })
  vi.stubGlobal('fetch', fetch)
  const { ShareReviewScreen } = await import('@/components/share/share-review-screen')
  render(<ShareReviewScreen token="link" assetId="a1" assetName="Still" permission="comment" allowDownload={false} showVersions={false} />)
  const input = await screen.findByPlaceholderText('Leave your comment...')
  fireEvent.change(input, { target: { value: 'Note' } })
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })

  if (status === 401) {
    const dialog = await screen.findByRole('dialog', { name: 'Your sign-in has expired.' })
    expect(writes).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('link', { name: 'Sign in' })).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue as guest' }))
  }
  await waitFor(() => expect(input).toHaveValue(''))
  const payload = { asset_id: 'a1', version_id: 'v1', body: 'Note' }
  if (status === 200) expect(writes).toHaveBeenCalledExactlyOnceWith(`Bearer ${alice}`, payload)
  else expect(writes).toHaveBeenCalledExactlyOnceWith(null, { ...payload, guest_name: guest.name, guest_email: guest.email })
})

it('sends a refused dashboard bootstrap to login with an app-relative return path', async () => {
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/frame')
  const { AuthBootstrap } = await import('@/components/auth/auth-bootstrap')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(refused()))
  const location = observeNavigation()
  render(<AuthBootstrap><div>Dashboard</div></AuthBootstrap>)
  await waitFor(() => expect(location.replace).toHaveBeenCalledWith('/frame/login?from=%2Fprojects%3Fview%3Dmine'))
  expect(screen.queryByText('Dashboard')).not.toBeInTheDocument()
})

it('retries restoration immediately after an explicit click', async () => {
  const { AuthBootstrap } = await import('@/components/auth/auth-bootstrap')
  const fetch = vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(restored(alice))
  vi.stubGlobal('fetch', fetch)
  vi.spyOn(Date, 'now').mockReturnValue(Date.now())
  render(<AuthBootstrap><div>Dashboard</div></AuthBootstrap>)
  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('Dashboard')).toBeInTheDocument()
  expect(fetch).toHaveBeenCalledTimes(2)
})
