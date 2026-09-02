export type ResolvedTheme = 'dark' | 'light'

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
