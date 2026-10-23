/**
 * Validate a post-login `from` target so it can only send the browser to a
 * path inside this app.
 *
 * The login page reads `?from=` and navigates to it after sign-in. Left
 * unchecked, a crafted link (`/login?from=https://evil.example`,
 * `/login?from=//evil.example`, or `/login?from=javascript:...`) turns that
 * into an open redirect or script execution. We accept only an app-absolute
 * path: it must start with a single `/`, must not be protocol-relative
 * (`//host` or `/\host`), and must carry no control characters the browser
 * might strip. Anything else falls back to the default.
 *
 * A valid internal path is returned unchanged, so normal `from` values (for
 * example `/projects` or `/projects/abc?tab=comments`) keep working.
 */
export function safeInternalPath(from: string | null | undefined, fallback = '/projects'): string {
  if (!from) return fallback
  // Must be an app-absolute path, not a full URL (`https:`, `javascript:`, …),
  // which never begins with `/`.
  if (!from.startsWith('/')) return fallback
  // Reject protocol-relative targets, including backslash variants that some
  // browsers normalise to `//`.
  if (from.startsWith('//') || from.startsWith('/\\')) return fallback
  // Reject control characters and whitespace a browser may strip to reveal a
  // different target.
  if (/[\u0000-\u001f\u007f\s]/.test(from)) return fallback
  return from
}
