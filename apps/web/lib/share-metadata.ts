import type { Metadata } from 'next'
import { withBasePath } from '@/lib/base-path'

/**
 * Server-side per-share Open Graph / Twitter metadata.
 *
 * A share link pasted into Telegram, WhatsApp or Slack should unfurl into a
 * card of its own — the share's title and its video thumbnail for links any
 * visitor can open, a plain branded card for everything else. The share page
 * itself is a client component, so this library is the server half: it asks
 * the API (server-to-server, via API_INTERNAL_URL) what the link is and turns
 * the answer into Next metadata.
 *
 * The data comes from the API's dedicated preview endpoint
 * `GET /share/{token}/preview` (see apps/api/routers/share.py), whose gate is
 * strictly stricter than the share page's own validation: it answers ONLY for
 * links a logged-out visitor could already open (enabled, not expired, not
 * login-required, not password-protected), and a refusing answer is a uniform
 * 404 that carries no link-specific text — not even the private title the
 * generic `GET /share/{token}` still includes for its password/sign-in gates.
 *
 * The governing rule remains FAIL CLOSED. Anything that is not a clean,
 * unambiguous preview answer produces the generic branded card:
 *
 *   - non-200 of any kind (404 missing/deleted/disabled/expired/gated,
 *     429 rate-limited, 5xx),
 *   - network errors, timeouts, non-JSON bodies, unparseable payloads,
 *   - any 200 whose title is missing or empty.
 *
 * Nothing here ever authenticates as a user. This is defense in depth: the
 * API enforces the gate server-side; if a future API version ever answers a
 * gated share with 200 again, a malformed or title-less body still cannot
 * publish it.
 *
 * Thumbnail lifetime: `og:image` points at the API's own
 * `GET /share/{token}/preview.jpg`, which re-checks the same strict gate on
 * every request server-side and streams bytes from storage with a
 * few-hours Cache-Control (or the static `logo-full.png` fallback). The S3
 * presign TTL is untouched — a crawler never sees a presigned URL.
 * See docs/og-share-previews.md.
 */

const INTERNAL_API_URL =
  process.env.API_INTERNAL_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  'http://localhost:8000'

/**
 * The API's crawlable public base as the browser world knows it: an absolute
 * URL in development (`http://localhost:8000`), the same-origin proxy path in
 * production (`/api` — Traefik strips the prefix when routing to the API).
 * Read lazily (not at module load) so tests can stub it per case.
 */
function publicApiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
}

/** Long enough for a slow container start, short enough not to hold a page. */
export const SHARE_FETCH_TIMEOUT_MS = 3000

/** Shown when the instance has no org name — same default the root layout uses. */
export const GENERIC_BRAND_TITLE = 'FreeFrame'

/** The generic card's description — the same one the root layout has always shown. */
export const GENERIC_SHARE_DESCRIPTION =
  'Collaborative media review and approval platform'

export interface ShareMetadataData {
  title: string
  description: string | null
}

export type ShareMetadataResult =
  | { ok: true; share: ShareMetadataData }
  | { ok: false }

/**
 * The uncached preview fetch. Exported for tests; `cache`-style memoisation is
 * deliberately absent — metadata is re-resolved on every request so a share
 * that gets password-protected, revoked or deleted stops producing rich
 * metadata immediately, not after a cache window.
 */
export async function fetchShareForMetadata(
  token: string,
): Promise<ShareMetadataResult> {
  try {
    const res = await fetch(
      `${INTERNAL_API_URL}/share/${encodeURIComponent(token)}/preview`,
      {
        // Fail closed on staleness: every request re-asks the API. The cost is
        // one internal round trip per crawler visit; share pages are not a hot
        // path (and this endpoint is deliberately outside the API's
        // per-IP share_validate limiter, in its own generous bucket).
        cache: 'no-store',
        signal: AbortSignal.timeout(SHARE_FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      },
    )
    // Non-200 = gated, missing, deleted, expired, rate-limited or a broken
    // API: none of these may produce metadata, and none of them tell us
    // anything safe to publish.
    if (res.status !== 200) return { ok: false }
    const parsed = parseShareMetadataPayload(await res.json())
    return parsed ? { ok: true, share: parsed } : { ok: false }
  } catch {
    // Never throw: an unreachable API must degrade to the generic card, the
    // same contract branding-server.ts keeps for instance branding.
    return { ok: false }
  }
}

/**
 * Narrow the API's preview response to exactly what a public card may show,
 * or null when the answer is not a clean "this is the share's public title".
 * Exported for tests — the fail-closed matrix lives here.
 */
export function parseShareMetadataPayload(
  data: unknown,
): ShareMetadataData | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>

  // A public card without a title has nothing to show; treat as fail-closed
  // rather than inventing one. The only other fields the endpoint returns —
  // description and has_image — are optional and never link-specific beyond
  // what the title already carries.
  const title = typeof d.title === 'string' ? d.title.trim() : ''
  if (!title) return null

  const description =
    typeof d.description === 'string' && d.description.trim()
      ? d.description.trim()
      : null

  return { title, description }
}

/**
 * Resolve the deployment's own public origin for absolute metadata URLs.
 *
 * `NEXT_PUBLIC_APP_URL` (optional) wins outright for operators who want to pin
 * it. Otherwise the request's forwarded headers decide — the deployment has no
 * app-URL env var (the production compose only knows NEXT_PUBLIC_API_URL, and
 * that one is the same-origin path `/api`), while the public host is always
 * present on the request that reached us. `get` is injected so callers can
 * feed this from `next/headers` (layout) or `request.headers` (route handler)
 * and tests can pass a plain lookup.
 */
export function resolveAppOriginFromHeaders(
  get: (name: string) => string | null | undefined,
): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL
  if (envUrl) {
    try {
      const u = new URL(envUrl)
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        return `${u.protocol}//${u.host}`
      }
    } catch {
      // Fall through to request headers on a bad value.
    }
  }

  // X-Forwarded-* can carry comma lists ("host1, host2") when several proxies
  // stacked; the leftmost entry is the one the client actually used.
  let host = firstValue(get('x-forwarded-host')) ?? get('host') ?? ''
  const proto = firstValue(get('x-forwarded-proto'))
  host = host.trim()
  // A conservative host shape: hostname, optional port, optional IPv6 literal.
  // Anything else (a path, a space, credentials) is not an origin we emit.
  if (host && /^[a-z0-9.\-]+(:\d{1,5})?$|^\[[0-9a-f:]+\](:\d{1,5})?$/i.test(host)) {
    // No forwarded proto header (direct dev access): assume https, which is
    // what every crawler-facing deployment runs behind.
    const scheme = proto === 'http' || proto === 'https' ? proto : 'https'
    return `${scheme}://${host}`
  }
  return 'http://localhost:3000'
}

function firstValue(value: string | null | undefined): string | null {
  if (!value) return null
  return value.split(',')[0]?.trim() || null
}

/**
 * The share card's og:image, absolute and crawler-accessible: the API's own
 * gated image endpoint, every time. It streams the share's thumbnail for a
 * gate-passing link, the static fallback logo otherwise, so this single URL
 * is correct for rich and generic cards alike — the image content is the
 * API's decision, re-made on every crawler fetch.
 *
 * The public API base is `NEXT_PUBLIC_API_URL`, exactly as the browser-side
 * caller sees it: an absolute URL (dev) is used as is; a path (`/api`,
 * production) is joined with the resolved request origin, and — like every
 * URL this file emits — goes through `withBasePath()` so a base-path
 * deployment emits base-path-aware absolute URLs.
 */
export function sharePreviewImageUrl(token: string, origin: string): string {
  const suffix = `/share/${encodeURIComponent(token)}/preview.jpg`
  const apiBase = publicApiBase()
  if (/^https?:\/\//i.test(apiBase)) {
    return new URL(`${apiBase.replace(/\/$/, "")}${suffix}`).toString()
  }
  return new URL(withBasePath(`${apiBase}${suffix}`), origin).toString()
}

/**
 * Build the final Metadata object for a share page.
 *
 * Both branches set title, description, openGraph, twitter and robots
 * explicitly — nothing is left to inherit from the root layout, so a private
 * value can never sneak in through a field this file did not write. Even the
 * generic card shows a real image (the API's gated fallback logo) so
 * protected links still unfurl as something deliberate rather than a blank box.
 */
export function buildShareMetadata(
  token: string,
  share: ShareMetadataResult,
  origin: string,
  orgName?: string | null,
): Metadata {
  let base: URL
  try {
    base = new URL(origin)
  } catch {
    base = new URL('http://localhost:3000')
  }
  const siteName = orgName?.trim() || GENERIC_BRAND_TITLE
  // Capability URLs must never leak into search results; preview fetchers
  // (Telegram, WhatsApp, Slack…) read og: tags regardless of robots, so this
  // only keeps the token out of search indexes.
  const robots = { index: false, follow: false }
  const pageUrl = new URL(
    withBasePath(`/share/${encodeURIComponent(token)}`),
    base,
  ).toString()
  const imageUrl = sharePreviewImageUrl(token, origin)

  if (!share.ok) {
    return {
      metadataBase: base,
      title: siteName,
      description: GENERIC_SHARE_DESCRIPTION,
      robots,
      openGraph: {
        title: siteName,
        description: GENERIC_SHARE_DESCRIPTION,
        url: pageUrl,
        siteName,
        type: 'website',
        images: [{ url: imageUrl, alt: siteName }],
      },
      twitter: {
        card: 'summary_large_image',
        title: siteName,
        description: GENERIC_SHARE_DESCRIPTION,
        images: [imageUrl],
      },
    }
  }

  const { title, description } = share.share
  const ogDescription = description ?? GENERIC_SHARE_DESCRIPTION

  return {
    metadataBase: base,
    title,
    description: ogDescription,
    robots,
    openGraph: {
      title,
      description: ogDescription,
      url: pageUrl,
      siteName,
      type: 'website',
      images: [{ url: imageUrl, alt: title }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: ogDescription,
      images: [imageUrl],
    },
  }
}
