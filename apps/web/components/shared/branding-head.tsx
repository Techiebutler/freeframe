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
    const org = orgName || 'FreeFrame'
    const current = document.title
    // Page titles are composed as "Page – Org" (usePageTitle, folder-share-viewer).
    // Preserve the page part and only swap the org suffix; set a bare org title
    // only when nothing page-specific is being shown (e.g. the initial
    // "FreeFrame" metadata title). Child effects run first, so a page title set
    // on mount is already present here.
    const idx = current ? current.lastIndexOf(' – ') : -1
    if (idx !== -1) {
      const next = `${current.slice(0, idx)} – ${org}`
      if (document.title !== next) {
        document.title = next
      }
    } else if (document.title !== org) {
      document.title = org
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
