'use client'

import { useEffect } from 'react'
import { useBranding } from '@/components/shared/branding-provider'

/**
 * Write `title` to the tab, but only into a `<title>` that already exists.
 *
 * With none in `<head>`, the `document.title` setter creates a plain one that
 * React does not know about. It is never removed, and it ends up as a second
 * `<title>` next to React's own, which is exactly what happens in the window
 * described on `holdDocumentTitle`.
 */
function writeTitle(title: string) {
  if (document.querySelector('title') && document.title !== title) document.title = title
}

/**
 * Keep the tab on `title` for as long as the returned cleanup has not run.
 *
 * The title from `generateMetadata` (the org name) is a React 19 hoistable
 * `<title>`, and React mounts it on its own schedule, not the page's. On every
 * client-side navigation it deletes the old element, builds a new one with the
 * metadata text and inserts it into `<head>` ahead of the old one (and, under
 * Next 16's hidden-then-revealed metadata boundary, removes and re-inserts it
 * once more). `document.title` reads and writes the FIRST `<title>` in the
 * document, so whenever that insertion lands after the page's effect has run,
 * the metadata title wins and the page title is lost. Measured on the sign-in
 * redirect and, in `next dev`, on later client navigations. On Next 14 / React
 * 18 the single write held (one `<title>`, stable).
 *
 * No single write can be ordered against that, so this re-applies the title
 * whenever `<head>` changes. It converges: a write only happens while the title
 * differs, and the write itself then finds it equal. It also holds off while
 * no `<title>` exists, since React is about to insert one and we write into it
 * then (see `writeTitle`).
 */
function holdDocumentTitle(title: string) {
  const apply = () => writeTitle(title)
  apply()
  const observer = new MutationObserver(apply)
  observer.observe(document.head, { childList: true, subtree: true, characterData: true })
  return () => observer.disconnect()
}

export function usePageTitle(title: string | null | undefined) {
  const orgName = useBranding().orgName || 'FreeFrame'

  useEffect(() => {
    const release = holdDocumentTitle(title ? `${title} – ${orgName}` : orgName)
    return () => {
      release()
      writeTitle(orgName)
    }
  }, [title, orgName])
}
