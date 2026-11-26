/**
 * Prefix an app-absolute path with the configured basePath.
 *
 * Only for navigations the framework does not rewrite for us: raw
 * `window.location` assignments, plain `<a href>` elements, and
 * `NextResponse.redirect` in the proxy. Next's router and `<Link>` add the
 * basePath themselves, so passing their targets through here would double it.
 *
 * Deployments mounted at a sub-path (e.g. /freeframe/) otherwise bounce to a
 * bare /login and hit the nginx catch-all 302 chain.
 */
export function withBasePath(path: string): string {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ''
  return `${basePath}${path}`
}

/** This page's path and query, without the basePath: what /login's `from` takes. */
export function currentAppPath(): string {
  if (typeof window === 'undefined') return '/'
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ''
  const { pathname, search } = window.location
  const underBasePath = basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))
  const path = underBasePath ? pathname.slice(basePath.length) || '/' : pathname
  return `${path}${search}`
}
