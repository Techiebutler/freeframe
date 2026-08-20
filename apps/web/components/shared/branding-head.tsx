'use client'

import * as React from 'react'
import { useBrandingStore } from '@/stores/branding-store'
import { accentVars, ACCENT_VAR_NAMES } from '@/lib/accent'

const DATA_ATTR = 'data-ff-branding'


/** Shown when an admin hasn't set one. The real mark, not a placeholder, so a
 *  reset leaves a correct icon rather than a missing one. */
const DEFAULT_ICON = '/logo-icon.png'

/**
 * Make this instance's icon the only one the browser can choose.
 *
 * Next emits its own `<link rel="icon">` for app/icon.png, and serves
 * app/favicon.ico at /favicon.ico which browsers request by convention. Merely
 * appending another link left the custom favicon as one candidate among
 * several, and it generally lost — which is why setting one appeared to do
 * nothing. Any icon link this component doesn't own is removed first.
 *
 * The link is always present, pointing at the default when nothing custom is
 * set, so clearing a favicon falls back cleanly instead of leaving the page
 * with no icon at all.
 */
function setIcon(rel: string, href: string) {
  document
    .querySelectorAll<HTMLLinkElement>(`link[rel="${rel}"]:not([${DATA_ATTR}])`)
    .forEach((el) => el.remove())

  let link = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"][${DATA_ATTR}]`)
  if (!link) {
    link = document.createElement('link')
    link.rel = rel
    link.setAttribute(DATA_ATTR, '')
    document.head.appendChild(link)
  }
  if (link.getAttribute('href') !== href) link.setAttribute('href', href)
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

  React.useEffect(() => {
    const href = faviconUrl || DEFAULT_ICON
    setIcon('icon', href)
    // Legacy rel too: without it a stale /favicon.ico can still win in some browsers.
    setIcon('shortcut icon', href)
  }, [faviconUrl])

  React.useEffect(() => {
    setIcon('apple-touch-icon', appleIconUrl || DEFAULT_ICON)
  }, [appleIconUrl])

  React.useEffect(() => {
    const root = document.documentElement
    const vars = accentVars(primaryColor)

    if (!vars) {
      // Clearing the colour hands every surface back to the stylesheet default,
      // rather than leaving the instance stuck on the last one set.
      ACCENT_VAR_NAMES.forEach((v) => root.style.removeProperty(v))
      root.style.removeProperty('--ff-primary')
      return
    }

    // Overriding the accent tokens rather than a bespoke variable is what makes
    // the colour reach the primary buttons, the download button on a share page
    // and the post-comment button: they all resolve through --accent, which
    // previously nothing branding-related ever touched. A share link with its
    // own accent still wins, because it sets these !important.
    Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v))
    // Kept for anyone already keying off it in custom CSS.
    root.style.setProperty('--ff-primary', primaryColor!)
  }, [primaryColor])

  return null
}
