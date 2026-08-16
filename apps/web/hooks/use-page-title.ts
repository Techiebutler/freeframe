'use client'

import { useEffect } from 'react'
import { useBrandingStore } from '@/stores/branding-store'

export function usePageTitle(title: string | null | undefined) {
  const orgName = useBrandingStore((s) => s.orgName) || 'FreeFrame'

  useEffect(() => {
    document.title = title ? `${title} – ${orgName}` : orgName
    return () => { document.title = orgName }
  }, [title, orgName])
}
