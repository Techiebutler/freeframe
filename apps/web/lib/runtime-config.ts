/**
 * Settings an operator can change by restarting the web container, with no
 * rebuild.
 *
 * Next inlines every `process.env.NEXT_PUBLIC_*` that is set when `next build`
 * runs, into server code as well as the browser bundle. A value read that way
 * is frozen into the image. So the server reads these from plain env vars at
 * request time (the root layout renders per request) and hands them to the
 * browser as attributes on `<html>`, which exist before any script runs.
 */

const DEFAULT_UPLOAD_CONCURRENCY = 5
const MAX_UPLOAD_CONCURRENCY = 16

/** Anything unusable (unset, empty, not a number, below 1) gives the default. */
export function parseUploadConcurrency(raw: unknown): number {
  const configured = Number(raw)
  if (!Number.isFinite(configured) || configured < 1) return DEFAULT_UPLOAD_CONCURRENCY
  return Math.min(Math.floor(configured), MAX_UPLOAD_CONCURRENCY)
}

/**
 * Server side. `UPLOAD_CONCURRENCY` is the runtime name; the older
 * `NEXT_PUBLIC_UPLOAD_CONCURRENCY` is still honoured so an existing `.env.prod`
 * keeps its value. That fallback only works because the production image no
 * longer sets the older name at build time (see Dockerfile.prod): a value set
 * then would be inlined here and the runtime one ignored.
 */
export function serverUploadConcurrency(): number {
  return parseUploadConcurrency(
    process.env.UPLOAD_CONCURRENCY ?? process.env.NEXT_PUBLIC_UPLOAD_CONCURRENCY,
  )
}

/** Browser side: the value the root layout put on `<html data-ff-upload-concurrency>`. */
export function clientUploadConcurrency(): number {
  return parseUploadConcurrency(
    typeof document !== 'undefined'
      ? document.documentElement.dataset.ffUploadConcurrency
      : undefined,
  )
}
