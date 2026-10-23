'use client'

import * as React from 'react'
import { useBranding } from '@/components/shared/branding-provider'
import { useResolvedTheme } from '@/hooks/use-resolved-theme'
import { resolveBrandingLogo } from '@/lib/branding-logo'
import { ThemedDefaultLogo } from '@/components/shared/themed-default-logo'

/**
 * The instance's logo in a share link's header (#308).
 *
 * One component for the folder grid and the asset review screen so the two
 * cannot drift apart. Same cascade as the password gate, so a guest does not
 * lose the logo one screen into the link. The project logo is not used: the
 * share API sends it as a storage key, not a URL.
 */
export function ShareBrandMark() {
  const { orgName, loginLogoUrl, orgLogoLight, orgLogoDark } = useBranding()
  const theme = useResolvedTheme()
  // Logo URLs are presigned and expire, so one that fails to load falls back to
  // the default mark. Keyed by URL so a refreshed link is tried again.
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null)

  const displayLogo = resolveBrandingLogo({
    theme,
    darkUrl: orgLogoDark,
    lightUrl: orgLogoLight,
    preferredUrl: loginLogoUrl,
  })

  if (displayLogo && displayLogo !== failedUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={displayLogo}
        alt={orgName}
        // Capped, and tighter on a phone, so a wide wordmark cannot squeeze the
        // asset name out of a header that also holds Download and the toggle.
        className="h-6 w-auto max-w-[64px] sm:max-w-[128px] object-contain shrink-0"
        onError={() => setFailedUrl(displayLogo)}
      />
    )
  }
  return <ThemedDefaultLogo variant="icon" alt="FreeFrame" className="h-6 w-6 shrink-0" />
}
