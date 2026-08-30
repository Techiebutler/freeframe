'use client'

import * as React from 'react'
import { useBrandingStore } from '@/stores/branding-store'
import { useResolvedTheme } from '@/hooks/use-resolved-theme'
import { ThemedDefaultLogo } from '@/components/shared/themed-default-logo'

/** Brand mark shown above the card on every auth screen (login, setup, invite). */
export function AuthBrandingHeader() {
  const { orgName, loginLogoUrl, orgLogoLight, orgLogoDark, fetchBranding, loaded } =
    useBrandingStore()
  const theme = useResolvedTheme()
  const [failedLogo, setFailedLogo] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!loaded) fetchBranding()
  }, [loaded, fetchBranding])

  const displayLogo =
    loginLogoUrl ||
    (theme === 'dark' ? (orgLogoDark ?? orgLogoLight) : (orgLogoLight ?? orgLogoDark)) ||
    undefined
  const showCustomLogo = displayLogo && displayLogo !== failedLogo

  return (
    <div className="relative mb-8 text-center">
      {showCustomLogo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={displayLogo}
          alt={orgName}
          className="h-12 mx-auto mb-3 object-contain"
          onError={() => setFailedLogo(displayLogo)}
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
