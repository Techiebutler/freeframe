/**
 * Prefix an app-absolute path with the configured basePath.
 *
 * Only for navigations the framework does not rewrite for us: raw
 * `window.location` assignments, plain `<a href>` elements, and
 * `NextResponse.redirect` in middleware. Next's router and `<Link>` add the
 * basePath themselves, so passing their targets through here would double it.
 *
 * Deployments mounted at a sub-path (e.g. /freeframe/) otherwise bounce to a
 * bare /login and hit the nginx catch-all 302 chain.
 */
export function withBasePath(path: string): string {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ''
  return `${basePath}${path}`
}
