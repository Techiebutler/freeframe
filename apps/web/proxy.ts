import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { withBasePath } from './lib/base-path'
import { INTERNAL_API_URL } from './lib/server-api'

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
        // Setup is done — set cookie so we don't check again
        const response = NextResponse.next()
        response.cookies.set('ff_setup_done', '1', { path: '/', maxAge: 60 * 60 * 24 }) // 24 hours
        return response
      }
    } catch {
      // API unreachable — let the request through, the page will show errors
    }
  }

  // Check for auth tokens
  const accessToken = request.cookies.get('ff_access_token')?.value
  const refreshToken = request.cookies.get('ff_refresh_token')?.value

  if (!accessToken && !refreshToken) {
    const loginUrl = new URL(withBasePath('/login'), request.url)
    loginUrl.searchParams.set('from', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
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
