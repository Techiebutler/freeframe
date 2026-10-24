'use client'

import * as React from 'react'
import { useBranding } from '@/components/shared/branding-provider'
import { logoUrlFromApi, resolveBrandingLogo } from '@/lib/branding-logo'
import { ThemedDefaultLogo } from '@/components/shared/themed-default-logo'

/**
 * The logo in a share link's header (#308).
 *
 * One component for the folder grid and the asset review screen so the two
 * cannot drift apart. The project's own logo comes first: the share API sends
 * it, already resolved to a loadable URL (the project cover when the project
 * uses it as its logo), for every link type. Without one, the instance's logo,
 * by the same cascade as the password gate so a guest does not lose the logo
 * one screen into the link; without that, the FreeFrame mark.
 *
 * `theme` is the link's, not the viewer's: a share page renders in the theme
 * its link sets (useShareAppearance), so the viewer's own preference would
 * pick the variant drawn for the other background. A project logo has one
 * variant and is used on either.
 */
export function ShareBrandMark({
  theme,
  projectLogoUrl,
}: {
  theme: 'dark' | 'light'
  projectLogoUrl?: string | null
}) {
  const { orgName, loginLogoUrl, orgLogoLight, orgLogoDark } = useBranding()
  // Logo URLs are presigned and expire, so one that fails to load falls back to
  // the next in line. Keyed by URL so a refreshed link is tried again.
  const [failed, setFailed] = React.useState<ReadonlySet<string>>(() => new Set())
  const markFailed = (url: string) => setFailed((prev) => new Set(prev).add(url))

  const projectLogo = logoUrlFromApi(projectLogoUrl)
  const instanceLogo = resolveBrandingLogo({
    theme,
    darkUrl: orgLogoDark,
    lightUrl: orgLogoLight,
    preferredUrl: loginLogoUrl,
  })

  const candidates: { url: string; alt: string }[] = []
  if (projectLogo) candidates.push({ url: projectLogo, alt: 'Project logo' })
  if (instanceLogo) candidates.push({ url: instanceLogo, alt: orgName })
  const shown = candidates.find((c) => !failed.has(c.url))

  if (shown) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={shown.url}
        src={shown.url}
        alt={shown.alt}
        // Capped, tighter on a phone, and the first thing in the header to give
        // way (down to 24px, the size of the default mark), so a wide wordmark
        // cannot squeeze out the asset name beside it.
        className="h-6 w-auto min-w-6 max-w-[64px] sm:max-w-[128px] object-contain object-left shrink"
        onError={() => markFailed(shown.url)}
      />
    )
  }
  return <ThemedDefaultLogo variant="icon" alt="FreeFrame" className="h-6 w-6 shrink-0" />
}
