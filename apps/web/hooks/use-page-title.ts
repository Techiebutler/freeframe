'use client'

import { useEffect } from 'react'
import { useBranding } from '@/components/shared/branding-provider'

export function usePageTitle(title: string | null | undefined) {
  const orgName = useBranding().orgName || 'FreeFrame'

  useEffect(() => {
    document.title = title ? `${title} – ${orgName}` : orgName
    return () => { document.title = orgName }
  }, [title, orgName])
}
