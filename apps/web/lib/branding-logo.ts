export type ResolvedTheme = 'dark' | 'light'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

/**
 * A logo URL from the branding API, as something the browser can load.
 *
 * The API answers with a stable path into itself (`/instance/branding/logo/<slot>`,
 * which redirects to a freshly signed link), so it is prefixed with the public
 * API base. Not `API_INTERNAL_URL`: the browser loads these, even when the HTML
 * that names them was rendered on the server. Anything already absolute is
 * passed through unchanged.
 */
export function logoUrlFromApi(url: string | null | undefined): string | null {
  if (!url) return null
  return url.startsWith('/') && !url.startsWith('//') ? `${API_URL}${url}` : url
}

interface ResolveBrandingLogoOptions {
  theme: ResolvedTheme
  darkUrl: string | null | undefined
  lightUrl: string | null | undefined
  /** A surface-specific logo, such as the dedicated sign-in mark. */
  preferredUrl?: string | null
}

/** Select the configured logo for a resolved theme, with the other variant as fallback. */
export function resolveBrandingLogo({
  theme,
  darkUrl,
  lightUrl,
  preferredUrl,
}: ResolveBrandingLogoOptions): string | undefined {
  if (preferredUrl) return preferredUrl

  const themedUrl = theme === 'dark' ? darkUrl ?? lightUrl : lightUrl ?? darkUrl
  return themedUrl || undefined
}
