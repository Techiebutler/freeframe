'use client'

import useSWR from "swr"
import { api } from "@/lib/api"
import type { ShareLinkListItem, ShareLink, ShareLinkActivity } from "@/types"

export function useShareLinks(projectId: string) {
  const { data, mutate, isLoading } = useSWR<ShareLinkListItem[]>(
    projectId ? `/projects/${projectId}/share-links` : null,
    (key: string) => api.get<ShareLinkListItem[]>(key),
  )

  async function toggleEnabled(token: string, is_enabled: boolean) {
    await api.patch(`/share/${token}`, { is_enabled })
    mutate()
  }

  async function updateShareLink(token: string, updates: Record<string, unknown>) {
    const result = await api.patch<ShareLink>(`/share/${token}`, updates)
    mutate()
    return result
  }

  async function deleteShareLink(token: string) {
    await api.delete(`/share/${token}`)
    mutate()
  }

  async function createFolderShare(folderId: string, data: Record<string, unknown>) {
    const result = await api.post<ShareLink>(`/folders/${folderId}/share`, data)
    mutate()
    return result
  }

  async function createAssetShare(assetId: string, data: Record<string, unknown>) {
    const result = await api.post<ShareLink>(`/assets/${assetId}/share`, data)
    mutate()
    return result
  }

  return {
    shareLinks: data ?? [],
    isLoading,
    mutateShareLinks: mutate,
    toggleEnabled,
    updateShareLink,
    deleteShareLink,
    createFolderShare,
    createAssetShare,
  }
}

export function useShareLinkActivity(token: string | null) {
  const { data, isLoading } = useSWR<ShareLinkActivity[]>(
    token ? `/share/${token}/activity` : null,
    (key: string) => api.get<ShareLinkActivity[]>(key),
  )
  return { activities: data ?? [], isLoading }
}
