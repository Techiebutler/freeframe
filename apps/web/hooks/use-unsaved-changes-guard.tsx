'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { isLeaveGuardSuppressed } from '@/lib/auth'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

/** An in-app link's target, as the router takes it, or null for one to leave alone. */
function inAppTarget(e: MouseEvent): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    return null
  }
  const anchor = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!anchor || anchor.hasAttribute('download')) return null
  if (anchor.target && anchor.target !== '_self') return null
  const url = new URL(anchor.href, window.location.href)
  if (url.origin !== window.location.origin) return null
  // Same page, another query or hash: nothing is lost.
  if (url.pathname === window.location.pathname) return null
  // The router adds the basePath itself.
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ''
  const path =
    basePath && url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) || '/' : url.pathname
  return `${path}${url.search}${url.hash}`
}

/**
 * Asks before unsaved changes are thrown away by leaving the page.
 *
 * Two ways out are covered while `dirty` is true: closing or reloading the tab
 * (the browser's own `beforeunload` prompt), and following an in-app link,
 * which is held back and offered in a dialog instead. The listeners are only
 * attached while there is something to lose. The browser's Back button is not
 * covered: the App Router gives no way to cancel it.
 *
 * Returns the dialog for the caller to render.
 */
export function useUnsavedChangesGuard(dirty: boolean): React.ReactNode {
  const router = useRouter()
  const [pendingHref, setPendingHref] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isLeaveGuardSuppressed()) return
      e.preventDefault()
      e.returnValue = ''
    }
    // Capture phase on the document, ahead of the router's own click handler
    // on the React root, so a held-back link never starts navigating.
    const onClick = (e: MouseEvent) => {
      const target = inAppTarget(e)
      if (!target) return
      e.preventDefault()
      e.stopPropagation()
      setPendingHref(target)
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('click', onClick, true)
    }
  }, [dirty])

  return (
    <ConfirmDialog
      open={pendingHref !== null}
      onOpenChange={(open) => {
        if (!open) setPendingHref(null)
      }}
      title="Leave without saving?"
      description="Your changes on this page have not been saved. They are lost if you leave now."
      confirmLabel="Leave"
      cancelLabel="Stay"
      variant="danger"
      onConfirm={() => {
        if (pendingHref) router.push(pendingHref)
      }}
    />
  )
}
