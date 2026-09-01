'use client'

import * as React from 'react'
import { useBrandingStore } from '@/stores/branding-store'
import { useResolvedTheme } from '@/hooks/use-resolved-theme'
import { resolveBrandingLogo } from '@/lib/branding-logo'
import { ThemedDefaultLogo } from '@/components/shared/themed-default-logo'

/** Brand mark shown above the card on every auth screen (login, setup, invite). */
export function AuthBrandingHeader() {
  const { orgName, loginLogoUrl, orgLogoLight, orgLogoDark, fetchBranding, loaded } =
    useBrandingStore()
  const theme = useResolvedTheme()
  const [logoErrored, setLogoErrored] = React.useState(false)

  React.useEffect(() => {
    if (!loaded) fetchBranding()
  }, [loaded, fetchBranding])

  const displayLogo = resolveBrandingLogo({
    theme,
    darkUrl: orgLogoDark,
    lightUrl: orgLogoLight,
    preferredUrl: loginLogoUrl,
  })

  React.useEffect(() => setLogoErrored(false), [displayLogo])

  return (
    <div className="relative mb-8 text-center">
      {displayLogo && !logoErrored ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={displayLogo}
          alt={orgName}
          className="h-12 mx-auto mb-3 object-contain"
          onError={() => setLogoErrored(true)}
        />
      ) : (
        <ThemedDefaultLogo
          variant="full"
          alt="FreeFrame"
          className="h-12 mx-auto mb-3 object-contain"
        />
      )}
      <h1 className="text-xl font-semibold text-text-primary">{orgName}</h1>
    </div>
  )
}
