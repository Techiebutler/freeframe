import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { ShareErrorState } from '@/components/share/share-error-state'
import { INTERNAL_API_URL, SERVER_FETCH_TIMEOUT_MS } from '@/lib/server-api'

// Short share links (e.g. /s/6RBr2cQd) land here: the code is looked up against
// the API server-side and the visitor is sent on to the share page. The `/s/`
// prefix is what keeps issued codes from ever shadowing a real route, so there
// is no reserved-word list to maintain.
//
// Codes are 8 base62 characters; anything outside this shape cannot be a code,
// and anything longer than the column's 16 characters cannot be one either.
const SHORT_CODE_PATTERN = /^[A-Za-z0-9]{4,16}$/

export const dynamic = 'force-dynamic'

export default async function ShortCodePage({
  params,
}: {
  params: Promise<{ code: string }>
}) {
  const { code } = await params
  if (!SHORT_CODE_PATTERN.test(code)) notFound()

  // The API's rate limiter keys on X-Real-Ip. This page runs on the web server,
  // so without forwarding the visitor's address every visitor shares the web
  // container's IP and one busy minute can drain the bucket for everyone.
  const requestHeaders = await headers()
  const visitorIp =
    requestHeaders.get('x-real-ip') ??
    requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    undefined

  let response: Response
  try {
    response = await fetch(`${INTERNAL_API_URL}/resolve/${encodeURIComponent(code)}`, {
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(SERVER_FETCH_TIMEOUT_MS),
      headers: visitorIp ? { 'x-real-ip': visitorIp } : undefined,
    })
  } catch (error) {
    // API unreachable or too slow. Log it, then show a retry screen — bouncing
    // to `/` would send an anonymous visitor to /login.
    console.error(`Short share code lookup failed for "${code}":`, error)
    return <ShareErrorState unavailable />
  }

  if (response.status === 302) {
    const destination = response.headers.get('location')
    if (!destination) {
      console.error(`Short share code lookup for "${code}" answered 302 without a Location`)
      return <ShareErrorState unavailable />
    }
    return redirect(destination)
  }

  // Only a 404 may be shown as "Link not found". A 429 (rate limited) or a 5xx
  // says nothing about the link, so those get the retry screen instead — telling
  // a visitor their link was removed because the API was busy would be wrong.
  if (response.status === 404) notFound()

  console.error(`Short share code lookup for "${code}" answered HTTP ${response.status}`)
  return <ShareErrorState unavailable />
}
