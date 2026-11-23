import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { withBasePath } from './lib/base-path'
import { INTERNAL_API_URL } from './lib/server-api'
import { HOST_REFRESH_COOKIE, LEGACY_REFRESH_COOKIE, usesRefreshCookie } from './lib/auth-transport'

const PUBLIC_ROUTES = ['/login', '/setup']
// `/s/` holds short share links (app/s/[code]), which redirect to a public
// share page — visitors following one are anonymous by design.
const PUBLIC_PREFIXES = ['/invite/', '/share/', '/s/']

// Server-to-server address, shared with the branding fetch and the
// short-share-link lookup so the fallback order lives in one place
// (lib/server-api.ts). NEXT_PUBLIC_API_URL is written for the browser (in the
// production image it is the relative path `/api`, which a server-side fetch
// cannot resolve), so without the internal address the setup check would
// always fail and the redirect to /setup would never fire.

function isPublicRoute(pathname: string): boolean {
  if (PUBLIC_ROUTES.includes(pathname)) return true
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true
  return false
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Always allow public routes
  if (isPublicRoute(pathname)) {
    return NextResponse.next()
  }

  // Check if setup is needed — redirect to /setup if no superadmin exists
  // Uses a cookie cache to avoid calling the API on every request
  const setupDone = request.cookies.get('ff_setup_done')?.value
  let cacheSetup = false
  if (!setupDone) {
    try {
      const res = await fetch(`${INTERNAL_API_URL}/setup/status`, {
        cache: 'no-store', // the ff_setup_done cookie is the cache
        // A slow API (migrating, overloaded) must not hold navigation: after
        // 2 seconds the check is dropped as if the API were unreachable.
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.needs_setup) {
          return NextResponse.redirect(new URL(withBasePath('/setup'), request.url))
        }
        cacheSetup = true
      }
    } catch {
      // API unreachable — let the request through, the page will show errors
    }
  }

  // This is a navigation hint, not authentication. The unprefixed refresh
  // cookie is needed both for HTTP deployments and for the migration window.
  const cookieMode = usesRefreshCookie(request.nextUrl.origin)
  const hasSession = cookieMode
    ? request.cookies.has(HOST_REFRESH_COOKIE) || request.cookies.has(LEGACY_REFRESH_COOKIE)
    : request.cookies.has('ff_access_token') || request.cookies.has(LEGACY_REFRESH_COOKIE)
  const loginUrl = new URL(withBasePath('/login'), request.url)
  loginUrl.searchParams.set('from', pathname)
  const response = hasSession ? NextResponse.next() : NextResponse.redirect(loginUrl)
  if (cacheSetup) {
    response.cookies.set('ff_setup_done', '1', {
      path: '/', maxAge: 60 * 60 * 24, httpOnly: true,
      sameSite: 'lax', secure: request.nextUrl.protocol === 'https:',
    })
  }
  return response
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - api routes
     * - public assets (images, fonts, etc.)
     */
    '/((?!_next/static|_next/image|favicon\\.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf)).*)',
  ],
}
