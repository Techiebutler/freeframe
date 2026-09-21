import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

// Root-level short share links (e.g. /6RBr) land here: the code is looked up
// against the API server-side and the visitor is sent on to the share page.
// Static routes win over a dynamic segment, so /login, /share/... and the rest
// are unaffected. No reverse-proxy configuration is needed.
const SHORT_CODE_PATTERN = /^[A-Za-z0-9]{4}$/

function apiBaseUrl(): string {
  const internal = process.env.API_INTERNAL_URL
  if (internal) return internal.replace(/\/+$/, '')

  const configured = process.env.NEXT_PUBLIC_API_URL || ''
  if (/^https?:\/\//i.test(configured)) return configured.replace(/\/+$/, '')

  // A relative base (`/api`) only makes sense against the origin the request
  // arrived on — the server cannot fetch a relative URL itself.
  const requestHeaders = headers()
  const host =
    requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host') ?? 'localhost'
  const proto = requestHeaders.get('x-forwarded-proto') ?? 'http'
  const path = configured.startsWith('/') ? configured : '/api'
  return `${proto}://${host}${path}`.replace(/\/+$/, '')
}

export const dynamic = 'force-dynamic'

export default async function ShortCodePage({
  params,
}: {
  params: { code: string }
}) {
  const { code } = params
  if (!SHORT_CODE_PATTERN.test(code)) redirect('/')

  let destination: string | null = null
  try {
    const response = await fetch(`${apiBaseUrl()}/resolve/${code}`, {
      redirect: 'manual',
      cache: 'no-store',
    })
    destination = response.headers.get('location')
  } catch {
    // API unreachable — fall through to the app root.
  }

  redirect(destination || '/')
}
