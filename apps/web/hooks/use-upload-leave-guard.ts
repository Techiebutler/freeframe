'use client'

import * as React from 'react'
import { useUploadStore, visibleFiles, wouldStopOnLeave } from '@/stores/upload-store'
import { isLeaveGuardSuppressed } from '@/lib/auth'

/**
 * Asks the browser to confirm before the page goes away while uploads would be
 * lost with it (spec goal 12): any of the signed-in account's uploads queued,
 * held, starting, sending, finalizing, or a resume waiting for its turn.
 *
 * The listener is on the window only while that is true. Firefox keeps a page
 * out of its back/forward cache for as long as a `beforeunload` listener is
 * attached, so one left on permanently would cost every page its instant Back.
 *
 * Best effort. Safari on iOS never fires `beforeunload`, every browser wants a
 * prior interaction with the page before it will show the prompt, and the text
 * is the browser's own. `preventDefault()` and `returnValue` are both set,
 * because browsers differ in which of the two they honour.
 *
 * Quiet for a session that is ending on purpose (`clearTokens`): the tokens are
 * already gone, and a "Stay" would leave a tab with no session.
 */
export function useUploadLeaveGuard(): void {
  // A boolean, so a progress write does not re-render the caller.
  const armed = useUploadStore((s) => visibleFiles(s).some(wouldStopOnLeave))

  React.useEffect(() => {
    if (!armed) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isLeaveGuardSuppressed()) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [armed])
}
