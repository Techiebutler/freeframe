'use client'

import { useEffect } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import type { AssetResponse } from '@/types'

/** A project opens on its first file in the player; with no files yet it falls back to the folder. */
export default function OpenReview() {
  const { id } = useParams<{ id: string }>()
  const folder = useSearchParams().get('folder')
  const router = useRouter()
  useEffect(() => {
    api.get<AssetResponse[]>(`/projects/${id}/assets?folder_id=${folder ?? 'root'}`)
      .then(assets => router.replace(assets[0] ? `/projects/${id}/assets/${assets[0].id}` : `/projects/${id}${folder ? `?folder=${folder}` : ''}`))
      .catch(() => router.replace(`/projects/${id}${folder ? `?folder=${folder}` : ''}`))
  }, [id, folder, router])
  return <div className="flex h-full items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>
}
