'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

interface StreamUrlResponse {
  url: string
}

/**
 * Fetch a version-scoped stream URL for a compare pane.
 * Mirrors VideoPlayer's internal fetch (incl. relative-HLS prefixing and the
 * ignore-flag anti-race guard) but is keyed on an explicit versionId instead
 * of the global review store.
 */
export function useStreamUrl(assetId: string | null, versionId: string | null) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let ignore = false
    setUrl(null)
    setError(false)
    if (!assetId || !versionId) return
    api
      .get<StreamUrlResponse>(`/assets/${assetId}/stream?version_id=${versionId}`)
      .then((data) => {
        if (ignore) return
        setUrl(
          data.url.startsWith('/')
            ? `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}${data.url}`
            : data.url,
        )
      })
      .catch(() => {
        if (!ignore) setError(true)
      })
    return () => {
      ignore = true
    }
  }, [assetId, versionId])

  return { url, error }
}
