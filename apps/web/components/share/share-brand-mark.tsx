'use client'

import * as React from 'react'
import { useBranding } from '@/components/shared/branding-provider'
import { resolveBrandingLogo } from '@/lib/branding-logo'
import { ThemedDefaultLogo } from '@/components/shared/themed-default-logo'

/**
 * The instance's logo in a share link's header (#308).
 *
 * One component for the folder grid and the asset review screen so the two
 * cannot drift apart. Same cascade as the password gate, so a guest does not
 * lose the logo one screen into the link. The project logo is not used: the
 * share API sends it as a storage key, not a URL.
 *
 * `theme` is the link's, not the viewer's: a share page renders in the theme
 * its link sets (useShareAppearance), so the viewer's own preference would
 * pick the variant drawn for the other background.
 */
export function ShareBrandMark({ theme }: { theme: 'dark' | 'light' }) {
  const { orgName, loginLogoUrl, orgLogoLight, orgLogoDark } = useBranding()
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
        // Capped, tighter on a phone, and the first thing in the header to give
        // way (down to 24px, the size of the default mark), so a wide wordmark
        // cannot squeeze out the asset name beside it.
        className="h-6 w-auto min-w-6 max-w-[64px] sm:max-w-[128px] object-contain object-left shrink"
        onError={() => setFailedUrl(displayLogo)}
      />
    )
  }
  return <ThemedDefaultLogo variant="icon" alt="FreeFrame" className="h-6 w-6 shrink-0" />
}
