import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from '../middleware'

// `ff_setup_done=1` skips the middleware's setup-status fetch, so these tests
// exercise the route/auth branches without a live API.
function request(path: string, cookie = 'ff_setup_done=1') {
  return new NextRequest(new URL(`http://localhost${path}`), {
    headers: cookie ? { cookie } : {},
  })
}

describe('middleware public routes', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_BASE_PATH
  })

  it('lets an anonymous visitor through to a short share link at /s/<code>', async () => {
    const response = await middleware(request('/s/AbC12345'))
    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(response.status).toBe(200)
  })

  it('still lets /share/ and /invite/ through', async () => {
    expect((await middleware(request('/share/tok123'))).headers.get('x-middleware-next')).toBe('1')
    expect((await middleware(request('/invite/tok'))).headers.get('x-middleware-next')).toBe('1')
  })

  it('sends a signed-out visitor on a protected route to /login', async () => {
    const response = await middleware(request('/projects'))
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain('/login')
  })

  it('does not treat a bare 4-character root path as public anymore', async () => {
    // The old shape rule made every /[A-Za-z0-9]{4} root path public. Codes live
    // under /s/ now, so a protected 4-character route must not slip through.
    const response = await middleware(request('/wxyz'))
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain('/login')
  })

  it('applies the basePath to the login redirect on a sub-path deployment', async () => {
    process.env.NEXT_PUBLIC_BASE_PATH = '/freeframe'
    const response = await middleware(request('/projects'))
    expect(response.headers.get('location')).toContain('/freeframe/login')
  })
})
