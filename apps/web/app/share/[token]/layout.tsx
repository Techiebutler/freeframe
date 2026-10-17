import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { headers } from 'next/headers'
import { getServerBranding } from '@/lib/branding-server'
import {
  buildShareMetadata,
  fetchShareForMetadata,
  resolveAppOriginFromHeaders,
} from '@/lib/share-metadata'

/**
 * Server-side metadata boundary for share links.
 *
 * `app/share/[token]/page.tsx` is a client component (it runs the interactive
 * share viewer), so per-share metadata cannot live there. This layout renders
 * nothing of its own — it exists so Next 14 calls `generateMetadata` while
 * server-rendering a share URL, producing og:/twitter: tags in the first HTML
 * byte, before any JavaScript runs. The interactive page below is untouched.
 *
 * The fetch is fail-closed (see lib/share-metadata.ts): anything that is not a
 * clean preview-endpoint answer — the API's `GET /share/{token}/preview`, which
 * itself refuses password and login-gated links with a bare 404 — collapses to
 * the generic branded card.
 */
export async function generateMetadata({
  params,
}: {
  params: { token: string }
}): Promise<Metadata> {
  // The deployment has no app-URL env var, so the public origin comes from the
  // request's forwarded headers (set metadataBase from it too, so Next
  // absolutises anything we might have missed).
  const requestHeaders = headers()
  const origin = resolveAppOriginFromHeaders((name) => requestHeaders.get(name))
  // Instance branding gives the generic card its own name instead of a bare
  // "FreeFrame". Both fetches resolve in parallel, each with its own timeout,
  // and neither can throw.
  const [branding, share] = await Promise.all([
    getServerBranding(),
    fetchShareForMetadata(params.token),
  ])
  return buildShareMetadata(
    params.token,
    share,
    origin,
    branding?.org_name ?? null,
  )
}

export default function ShareTokenLayout({
  children,
}: {
  children: ReactNode
}) {
  // Renders nothing — the interactive share page (and the drag-guard layout
  // above it) stays exactly as it was.
  return children
}
