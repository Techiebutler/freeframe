'use client'

import { useEffect } from 'react'

/**
 * Sets the browser tab title. Appends " – FreeFrame" suffix.
 * Pass null/undefined to reset to default "FreeFrame".
 */
export function usePageTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} – FreeFrame` : 'FreeFrame'
    return () => { document.title = 'FreeFrame' }
  }, [title])
}
