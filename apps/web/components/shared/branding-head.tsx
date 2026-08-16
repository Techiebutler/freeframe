'use client'

import * as React from 'react'
import { useBrandingStore } from '@/stores/branding-store'

const DATA_ATTR = 'data-ff-branding'

function setLink(rel: string, href: string | null) {
  const selector = `link[rel="${rel}"][${DATA_ATTR}]`
  const existing = document.querySelector<HTMLLinkElement>(selector)
  if (href) {
    if (existing) {
      existing.href = href
    } else {
      const link = document.createElement('link')
      link.rel = rel
      link.href = href
      link.setAttribute(DATA_ATTR, '')
      document.head.appendChild(link)
    }
  } else if (existing) {
    existing.remove()
  }
}

export function BrandingHead() {
  const { orgName, faviconUrl, appleIconUrl, primaryColor, fetchBranding, loaded } =
    useBrandingStore()

  React.useEffect(() => {
    if (!loaded) fetchBranding()
  }, [loaded, fetchBranding])

  React.useEffect(() => {
    const title = orgName || 'FreeFrame'
    if (document.title !== title) {
      document.title = title
    }
  }, [orgName])

  React.useEffect(() => { setLink('icon', faviconUrl) }, [faviconUrl])
  React.useEffect(() => { setLink('apple-touch-icon', appleIconUrl) }, [appleIconUrl])

  React.useEffect(() => {
    if (primaryColor) {
      document.documentElement.style.setProperty('--ff-primary', primaryColor)
    } else {
      document.documentElement.style.removeProperty('--ff-primary')
    }
  }, [primaryColor])

  return null
}
