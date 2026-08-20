'use client'

import * as React from 'react'
import { useBrandingStore } from '@/stores/branding-store'
import { useResolvedTheme } from '@/hooks/use-resolved-theme'

const FALLBACK_LOGO = '/logo-full.svg'

/** Brand mark shown above the card on every auth screen (login, setup, invite). */
export function AuthBrandingHeader() {
  const { orgName, loginLogoUrl, orgLogoLight, orgLogoDark, fetchBranding, loaded } =
    useBrandingStore()
  const theme = useResolvedTheme()
  const usedFallback = React.useRef(false)

  React.useEffect(() => {
    if (!loaded) fetchBranding()
  }, [loaded, fetchBranding])

  const displayLogo =
    loginLogoUrl ||
    (theme === 'dark' ? (orgLogoDark ?? orgLogoLight) : (orgLogoLight ?? orgLogoDark)) ||
    undefined

  return (
    <div className="relative mb-8 text-center">
      {displayLogo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={displayLogo}
          alt={orgName}
          className="h-12 mx-auto mb-3 object-contain"
          onError={(e) => {
            // Swap in the default mark once — the DOM reports src as an absolute URL,
            // so comparing it to the relative path never matches and an unreachable
            // fallback would retrigger onError forever.
            if (usedFallback.current) return
            usedFallback.current = true
            e.currentTarget.src = FALLBACK_LOGO
          }}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={FALLBACK_LOGO}
          alt="FreeFrame"
          className="h-12 mx-auto mb-3 object-contain"
        />
      )}
      <h1 className="text-xl font-semibold text-text-primary">{orgName}</h1>
    </div>
  )
}
