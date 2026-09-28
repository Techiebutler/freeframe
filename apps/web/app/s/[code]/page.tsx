import { redirect } from 'next/navigation'
import { ShareErrorState } from '@/components/share/share-error-state'
import { INTERNAL_API_URL, SERVER_FETCH_TIMEOUT_MS } from '@/lib/server-api'

// Short share links (e.g. /s/6RBr2cQd) land here: the code is looked up against
// the API server-side and the visitor is sent on to the share page. The `/s/`
// prefix is what keeps issued codes from ever shadowing a real route, so there
// is no reserved-word list to maintain.
//
// 4 is the legacy floor (codes issued before this landed); new codes are 8
// characters. Anything longer than the column's 16 characters cannot be a code.
const SHORT_CODE_PATTERN = /^[A-Za-z0-9]{4,16}$/

export const dynamic = 'force-dynamic'

export default async function ShortCodePage({
  params,
}: {
  params: { code: string }
}) {
  const { code } = params
  if (!SHORT_CODE_PATTERN.test(code)) return <ShareErrorState />

  let response: Response
  try {
    response = await fetch(`${INTERNAL_API_URL}/resolve/${encodeURIComponent(code)}`, {
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(SERVER_FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    // API unreachable or too slow. Log it, then show the share page's own
    // dead end — bouncing to `/` would send an anonymous visitor to /login.
    console.error(`Short share code lookup failed for "${code}":`, error)
    return <ShareErrorState />
  }

  const destination = response.headers.get('location')
  // A known code answers 302 with a Location; unknown or deleted codes answer
  // 404. Either way, no Location means "not found".
  if (!destination) return <ShareErrorState />

  redirect(destination)
}
